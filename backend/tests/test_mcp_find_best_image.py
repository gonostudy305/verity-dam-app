"""Unit tests for media_find_best_image_for_post and composer engine."""

from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from verity_dam_mcp.image_fit import (
    extract_search_query,
    find_best_image,
    render_find_best_markdown,
)
from verity_dam_mcp.models import (
    CandidateFit,
    ContextRelevance,
    EvaluateImageFitOutput,
    FindBestImageInput,
    FindBestImageOutput,
    MediaSearchInput,
    MediaSearchOutput,
    MediaSearchResultItem,
    MediaSearchSearchMeta,
    ProductMatch,
    ProductSafetyState,
    RecentUsageCheck,
    TechnicalSuitability,
)


class QueryExtractionTests(unittest.TestCase):
    def test_extracts_from_markdown_title(self):
        text = "# Khóa Thông Minh Acme M100 Hiện Đại Cho Chung Cư\n\nNội dung bài viết chi tiết..."
        q = extract_search_query(text)
        self.assertEqual(q, "Khóa Thông Minh Acme M100 Hiện Đại Cho Chung Cư")

    def test_adds_product_hint_if_missing(self):
        text = "Giải pháp bảo vệ an ninh toàn diện cho ngôi nhà hiện đại của bạn."
        q = extract_search_query(text, product_hint="Acme A100")
        self.assertTrue(q.startswith("Acme A100"))
        self.assertIn("Giải pháp bảo vệ an ninh", q)

    def test_avoids_duplicate_product_hint_if_already_present(self):
        text = "Khám phá đèn thông minh Lumos Arwen thế hệ mới"
        q = extract_search_query(text, product_hint="Lumos Arwen")
        self.assertEqual(q, "Khám phá đèn thông minh Lumos Arwen thế hệ mới")

    def test_fallback_when_empty_text(self):
        self.assertEqual(extract_search_query("", product_hint="AC-S20"), "AC-S20")
        self.assertEqual(extract_search_query("   "), "thiết bị thông minh")


class FindBestImageOrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.mock_gateway = MagicMock()
        self.mock_settings = MagicMock()

    def _make_candidate(self, asset_id: str, title: str, score: float = 0.85):
        return MediaSearchResultItem(
            asset_id=asset_id,
            title=title,
            score=score,
            permission="public",
            status="approved",
            thumbnail_url=f"https://r2.test/{asset_id}.webp",
            product_safety=ProductSafetyState(safe_for_exact_product_use=True),
        )

    def test_ranks_by_fit_grade_and_selects_best_pick(self):
        c1 = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100 Cửa Gỗ", score=0.9)
        c2 = self._make_candidate("22222222-2222-2222-2222-222222222222", "Acme A100 Cửa Kính", score=0.95)
        c3 = self._make_candidate("33333333-3333-3333-3333-333333333333", "Chuông Cửa G4", score=0.7)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query,
                total=3,
                returned=3,
                results=[c1, c2, c3],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        # c1 has grade 3 (Ideal), c2 has grade 2 (Highly Relevant), c3 has grade 0 (Irrelevant)
        def mock_eval_fit(gw, st, req):
            if req.media_asset_id == c1.asset_id:
                return EvaluateImageFitOutput(
                    media_asset_id=c1.asset_id,
                    fit_grade=3,
                    fit_label="Ideal",
                    rationale="Khớp chính xác Acme M100",
                    context_relevance=ContextRelevance(relevance_score=0.98),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                    product_match=ProductMatch(matched=True),
                    already_used_recently=RecentUsageCheck(used=False),
                )
            elif req.media_asset_id == c2.asset_id:
                return EvaluateImageFitOutput(
                    media_asset_id=c2.asset_id,
                    fit_grade=2,
                    fit_label="Highly Relevant",
                    rationale="Khóa dòng A tương tự",
                    context_relevance=ContextRelevance(relevance_score=0.8),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                    product_match=ProductMatch(matched=False),
                    already_used_recently=RecentUsageCheck(used=False),
                )
            else:
                return EvaluateImageFitOutput(
                    media_asset_id=c3.asset_id,
                    fit_grade=0,
                    fit_label="Irrelevant",
                    rationale="Lệch chủ đề (chuông cửa)",
                    context_relevance=ContextRelevance(relevance_score=0.1),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=False),
                    product_match=ProductMatch(matched=False),
                    already_used_recently=RecentUsageCheck(used=False),
                )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="# Khóa cửa thông minh Acme M100\nGiới thiệu dòng khóa cao cấp.",
                channel="facebook",
                product_hint="M100",
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNotNone(out.best_pick)
        self.assertEqual(out.best_pick.asset_id, c1.asset_id)
        self.assertEqual(out.best_pick.fit_grade, 3)
        self.assertEqual(len(out.ranked_candidates), 3)
        # Check order: c1 (grade 3) -> c2 (grade 2) -> c3 (grade 0)
        self.assertEqual(out.ranked_candidates[0].asset_id, c1.asset_id)
        self.assertEqual(out.ranked_candidates[1].asset_id, c2.asset_id)
        self.assertEqual(out.ranked_candidates[2].asset_id, c3.asset_id)
        self.assertIn("Ảnh tối ưu nhất", out.markdown_summary)

    def test_never_requests_unfinished_assets_as_candidates(self):
        # Phase 02 (needs_post_production discovery exclusion) relies on
        # find_best_image() never opting in to needs_post_production
        # candidates -- MediaSearchInput.include_unfinished must stay at its
        # False default on every search_fn call this composer makes.
        captured_requests: list[MediaSearchInput] = []

        def mock_search(req: MediaSearchInput):
            captured_requests.append(req)
            return MediaSearchOutput(
                query=req.query,
                total=0,
                returned=0,
                results=[],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        inp = FindBestImageInput(
            post_text="Khóa cửa thông minh Acme M100",
            channel="facebook",
            product_hint="M100",
        )
        find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertTrue(captured_requests)
        for req in captured_requests:
            self.assertFalse(req.include_unfinished)

    def test_prefers_unused_asset_when_grades_are_equal(self):
        c_used = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100 Cũ (Đã đăng)", score=0.98)
        c_fresh = self._make_candidate("22222222-2222-2222-2222-222222222222", "Acme M100 Mới (Chưa đăng)", score=0.85)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query,
                total=2,
                returned=2,
                results=[c_used, c_fresh],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            is_used = (req.media_asset_id == c_used.asset_id)
            return EvaluateImageFitOutput(
                media_asset_id=req.media_asset_id,
                fit_grade=3,
                fit_label="Ideal",
                rationale="Khớp hoàn hảo",
                context_relevance=ContextRelevance(relevance_score=0.95),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(used=is_used, usage_count=1 if is_used else 0),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Bài viết giới thiệu khóa Acme M100",
                channel="facebook",
                exclude_used_within_days=14,
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        # Fresh candidate must be chosen as best_pick even if c_used had higher search score
        self.assertIsNotNone(out.best_pick)
        self.assertEqual(out.best_pick.asset_id, c_fresh.asset_id)
        # Fresh candidate should rank before used candidate
        self.assertEqual(out.ranked_candidates[0].asset_id, c_fresh.asset_id)
        self.assertEqual(out.ranked_candidates[1].asset_id, c_used.asset_id)

    def test_returns_none_best_pick_if_no_candidate_meets_min_fit_grade(self):
        c1 = self._make_candidate("11111111-1111-1111-1111-111111111111", "Rèm Cửa Thông Minh", score=0.7)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query,
                total=1,
                returned=1,
                results=[c1],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            return EvaluateImageFitOutput(
                media_asset_id=c1.asset_id,
                fit_grade=1,  # Only grade 1 (Marginally Relevant)
                fit_label="Marginally Relevant",
                rationale="Liên quan mờ nhạt đến chủ đề khóa cửa",
                context_relevance=ContextRelevance(relevance_score=0.4),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=False),
                already_used_recently=RecentUsageCheck(used=False),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Khóa thông minh bảo mật cao",
                channel="facebook",
                min_fit_grade=2,  # Require at least grade 2
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNone(out.best_pick)
        self.assertEqual(len(out.ranked_candidates), 1)
        self.assertIn("Không tìm thấy ảnh đạt chuẩn", out.markdown_summary)

    def test_fallback_search_when_initial_query_empty(self):
        c_fallback = self._make_candidate("99999999-9999-9999-9999-999999999999", "Acme U100", score=0.8)

        def mock_search(req: MediaSearchInput):
            if req.query == "Bài viết dài không tìm thấy gì":
                return MediaSearchOutput(
                    query=req.query, total=0, returned=0, results=[],
                    search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
                )
            if req.query == "Acme U100":
                return MediaSearchOutput(
                    query=req.query, total=1, returned=1, results=[c_fallback],
                    search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
                )
            return MediaSearchOutput(
                query=req.query, total=0, returned=0, results=[],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            return EvaluateImageFitOutput(
                media_asset_id=c_fallback.asset_id,
                fit_grade=3,
                fit_label="Ideal",
                rationale="Khớp SKU U100",
                context_relevance=ContextRelevance(relevance_score=0.9),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(used=False),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Bài viết dài không tìm thấy gì",
                search_query="Bài viết dài không tìm thấy gì",
                product_hint="Acme U100",
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNotNone(out.best_pick)
        self.assertEqual(out.best_pick.asset_id, c_fallback.asset_id)

    def test_starvation_breaker_grade2_never_used_beats_grade3_recently_used(self):
        # Asset A: Grade 3, used 1 day ago (recent)
        c_grade3_recent = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100 Grade 3 Recent", score=0.99)
        # Asset C: Grade 2, never used
        c_grade2_fresh = self._make_candidate("22222222-2222-2222-2222-222222222222", "Acme M100 Grade 2 Fresh", score=0.88)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query, total=2, returned=2, results=[c_grade3_recent, c_grade2_fresh],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            if req.media_asset_id == c_grade3_recent.asset_id:
                return EvaluateImageFitOutput(
                    media_asset_id=req.media_asset_id,
                    fit_grade=3,
                    fit_label="Ideal",
                    rationale="Khớp chính xác nhưng đã dùng gần đây",
                    context_relevance=ContextRelevance(relevance_score=0.99),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                    product_match=ProductMatch(matched=True),
                    already_used_recently=RecentUsageCheck(
                        used=True,
                        usage_count=1,
                        recent_count=1,
                        total_count=1,
                        last_used_at="2026-09-09T10:00:00+00:00",
                    ),
                )
            return EvaluateImageFitOutput(
                media_asset_id=req.media_asset_id,
                fit_grade=2,
                fit_label="Highly Relevant",
                rationale="Khớp tốt và chưa từng dùng",
                context_relevance=ContextRelevance(relevance_score=0.88),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(
                    used=False,
                    usage_count=0,
                    recent_count=0,
                    total_count=0,
                    last_used_at=None,
                ),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Bài viết giới thiệu Acme M100",
                channel="facebook",
                exclude_used_within_days=14,
                min_fit_grade=2,
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNotNone(out.best_pick)
        # Grade 2 never-used MUST beat Grade 3 recently used
        self.assertEqual(out.best_pick.asset_id, c_grade2_fresh.asset_id)
        self.assertEqual(out.best_pick.fit_grade, 2)
        # Verify synchronized ranked list invariant
        self.assertEqual(out.ranked_candidates[0].asset_id, c_grade2_fresh.asset_id)
        self.assertEqual(out.ranked_candidates[1].asset_id, c_grade3_recent.asset_id)

    def test_zero_window_disables_rotation(self):
        c_grade3_recent = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100 Grade 3 Recent", score=0.99)
        c_grade2_fresh = self._make_candidate("22222222-2222-2222-2222-222222222222", "Acme M100 Grade 2 Fresh", score=0.88)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query, total=2, returned=2, results=[c_grade3_recent, c_grade2_fresh],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            # Verify within_days was passed as 0
            self.assertEqual(req.within_days, 0)
            if req.media_asset_id == c_grade3_recent.asset_id:
                return EvaluateImageFitOutput(
                    media_asset_id=req.media_asset_id,
                    fit_grade=3,
                    fit_label="Ideal",
                    rationale="Khớp chính xác",
                    context_relevance=ContextRelevance(relevance_score=0.99),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                    product_match=ProductMatch(matched=True),
                    already_used_recently=RecentUsageCheck(
                        used=False,
                        usage_count=0,
                        total_count=5,
                        last_used_at="2026-09-09T10:00:00+00:00",
                    ),
                )
            return EvaluateImageFitOutput(
                media_asset_id=req.media_asset_id,
                fit_grade=2,
                fit_label="Highly Relevant",
                rationale="Khớp tốt",
                context_relevance=ContextRelevance(relevance_score=0.88),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(
                    used=False,
                    usage_count=0,
                    total_count=0,
                    last_used_at=None,
                ),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Bài viết giới thiệu Acme M100",
                channel="facebook",
                exclude_used_within_days=0,  # Rotation OFF
                min_fit_grade=2,
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNotNone(out.best_pick)
        # When rotation is OFF, Grade 3 must win over Grade 2
        self.assertEqual(out.best_pick.asset_id, c_grade3_recent.asset_id)
        self.assertEqual(out.best_pick.fit_grade, 3)
        self.assertEqual(out.ranked_candidates[0].asset_id, c_grade3_recent.asset_id)

    def test_lru_fallback_when_all_candidates_recently_used(self):
        # Two candidates, both recent. c_older used 10 days ago, c_newer used 1 day ago.
        c_newer = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100 Dùng 1 ngày trước", score=0.95)
        c_older = self._make_candidate("22222222-2222-2222-2222-222222222222", "Acme M100 Dùng 10 ngày trước", score=0.90)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query, total=2, returned=2, results=[c_newer, c_older],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            if req.media_asset_id == c_newer.asset_id:
                return EvaluateImageFitOutput(
                    media_asset_id=req.media_asset_id,
                    fit_grade=3,
                    fit_label="Ideal",
                    rationale="Dùng 1 ngày trước",
                    context_relevance=ContextRelevance(relevance_score=0.95),
                    technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                    product_match=ProductMatch(matched=True),
                    already_used_recently=RecentUsageCheck(
                        used=True,
                        usage_count=1,
                        recent_count=1,
                        total_count=1,
                        last_used_at="2026-09-09T10:00:00+00:00",
                    ),
                )
            return EvaluateImageFitOutput(
                media_asset_id=req.media_asset_id,
                fit_grade=3,
                fit_label="Ideal",
                rationale="Dùng 10 ngày trước",
                context_relevance=ContextRelevance(relevance_score=0.90),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(
                    used=True,
                    usage_count=1,
                    recent_count=1,
                    total_count=1,
                    last_used_at="2026-08-31T10:00:00+00:00",
                ),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(
                post_text="Bài viết giới thiệu Acme M100",
                channel="facebook",
                exclude_used_within_days=14,
            )
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        # LRU fallback must pick the oldest used candidate
        self.assertIsNotNone(out.best_pick)
        self.assertEqual(out.best_pick.asset_id, c_older.asset_id)
        self.assertEqual(out.ranked_candidates[0].asset_id, c_older.asset_id)

    def test_best_pick_is_first_ranked_qualifying_candidate(self):
        c1 = self._make_candidate("11111111-1111-1111-1111-111111111111", "Acme M100", score=0.9)

        def mock_search(req: MediaSearchInput):
            return MediaSearchOutput(
                query=req.query, total=1, returned=1, results=[c1],
                search_meta=MediaSearchSearchMeta(used=True, actor_role="bot"),
            )

        def mock_eval_fit(gw, st, req):
            return EvaluateImageFitOutput(
                media_asset_id=c1.asset_id,
                fit_grade=3,
                fit_label="Ideal",
                rationale="Khớp",
                context_relevance=ContextRelevance(relevance_score=0.9),
                technical_suitability=TechnicalSuitability(channel="facebook", suitable_for_feed=True),
                product_match=ProductMatch(matched=True),
                already_used_recently=RecentUsageCheck(used=False),
            )

        with patch("verity_dam_mcp.image_fit.evaluate_image_fit", side_effect=mock_eval_fit):
            inp = FindBestImageInput(post_text="Test", channel="facebook")
            out = find_best_image(self.mock_gateway, self.mock_settings, mock_search, inp)

        self.assertIsNotNone(out.best_pick)
        self.assertEqual(out.best_pick, out.ranked_candidates[0])


class GatewayUsageStatsTests(unittest.TestCase):
    def test_usage_stats_on_channel_query_and_parsing(self):
        from datetime import datetime, timezone
        from verity_dam_mcp.gateway import MediaMcpGateway

        mock_repo = MagicMock()
        mock_repo.fetch_one.return_value = {
            "total_count": 5,
            "recent_count": 2,
            "last_used_at": datetime(2026, 9, 8, 12, 0, 0, tzinfo=timezone.utc),
        }

        gw = MediaMcpGateway.__new__(MediaMcpGateway)
        gw.repository = mock_repo
        gw._user_id = "00000000-0000-0000-0000-000000000001"

        stats = gw.usage_stats_on_channel(
            asset_id="11111111-1111-1111-1111-111111111111",
            channel=" Facebook ",
            within_days=7,
        )

        self.assertTrue(stats["used"])
        self.assertEqual(stats["total_count"], 5)
        self.assertEqual(stats["recent_count"], 2)
        self.assertEqual(stats["channel"], "facebook")
        self.assertEqual(stats["within_days"], 7)
        self.assertIn("2026-09-08", stats["last_used_at"])

        # Verify SQL parameter binding order: (within_days, asset_id, channel.strip())
        mock_repo.fetch_one.assert_called_once()
        call_args = mock_repo.fetch_one.call_args[0]
        params = call_args[1]
        self.assertEqual(params, (7, "11111111-1111-1111-1111-111111111111", "Facebook"))

    def test_recent_usage_on_channel_backward_compatibility(self):
        from verity_dam_mcp.gateway import MediaMcpGateway

        gw = MediaMcpGateway.__new__(MediaMcpGateway)
        gw.usage_stats_on_channel = MagicMock(return_value={
            "used": True,
            "total_count": 3,
            "recent_count": 1,
            "last_used_at": "2026-09-08T12:00:00+00:00",
            "channel": "facebook",
            "within_days": 14,
        })

        res = gw.recent_usage_on_channel("asset-123", "facebook", within_days=14)
        self.assertIsNotNone(res)
        self.assertTrue(res["used"])
        self.assertEqual(res["count"], 1)
        self.assertEqual(res["last_used_at"], "2026-09-08T12:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
