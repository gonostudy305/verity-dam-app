"""Unit tests for media_evaluate_image_fit and image_fit evaluation engine."""

from __future__ import annotations

import base64
import unittest
from unittest.mock import MagicMock, patch

from pydantic import ValidationError

from verity_dam_mcp.image_fit import (
    check_product_match,
    evaluate_image_fit,
    evaluate_technical_suitability,
    fit_messages,
    sanitize_image_fit_response,
)
from verity_dam_mcp.models import (
    EvaluateImageFitInput,
    EvaluateImageFitOutput,
)


class EvaluateImageFitInputValidationTests(unittest.TestCase):
    def test_requires_at_least_one_image_source(self):
        with self.assertRaises(ValidationError):
            EvaluateImageFitInput(
                article_text="Bài viết về chuông cửa Acme G4 thông minh.",
            )

    def test_rejects_both_image_sources(self):
        with self.assertRaises(ValidationError):
            EvaluateImageFitInput(
                article_text="Bài viết về chuông cửa Acme G4 thông minh.",
                media_asset_id="11111111-1111-1111-1111-111111111111",
                image_base64="dGVzdA==",
            )

    def test_accepts_media_asset_id_alone(self):
        inp = EvaluateImageFitInput(
            article_text="Bài viết về chuông cửa Acme G4 thông minh.",
            media_asset_id="11111111-1111-1111-1111-111111111111",
            channel="facebook",
        )
        self.assertEqual(inp.media_asset_id, "11111111-1111-1111-1111-111111111111")
        self.assertIsNone(inp.image_base64)

    def test_accepts_image_base64_alone(self):
        inp = EvaluateImageFitInput(
            article_text="Bài viết về chuông cửa Acme G4 thông minh.",
            image_base64="dGVzdA==",
            channel="website",
            product_hint="Acme G4",
        )
        self.assertEqual(inp.image_base64, "dGVzdA==")
        self.assertIsNone(inp.media_asset_id)


class TechnicalSuitabilityTests(unittest.TestCase):
    def test_facebook_square_is_suitable_for_feed(self):
        res = evaluate_technical_suitability("facebook", 1080, 1080)
        self.assertEqual(res.aspect_ratio, "1:1")
        self.assertTrue(res.suitable_for_feed)
        self.assertFalse(res.suitable_for_story)

    def test_facebook_vertical_is_suitable_for_story(self):
        res = evaluate_technical_suitability("facebook", 1080, 1920)
        self.assertEqual(res.aspect_ratio, "9:16")
        self.assertFalse(res.suitable_for_feed)
        self.assertTrue(res.suitable_for_story)

    def test_website_16_9_is_suitable(self):
        res = evaluate_technical_suitability("website", 1920, 1080)
        self.assertEqual(res.aspect_ratio, "16:9")
        self.assertTrue(res.suitable_for_feed)

    def test_tiktok_9_16_is_suitable_for_feed(self):
        res = evaluate_technical_suitability("tiktok", 720, 1280)
        self.assertEqual(res.aspect_ratio, "9:16")
        self.assertTrue(res.suitable_for_feed)
        self.assertTrue(res.suitable_for_story)

    def test_missing_dimensions_handled_gracefully(self):
        res = evaluate_technical_suitability("facebook", None, None)
        self.assertEqual(res.aspect_ratio, "unknown")
        self.assertTrue(res.suitable_for_feed)


class ProductMatchTests(unittest.TestCase):
    def test_no_hint_always_matches(self):
        pm = check_product_match(["AC-S20"], None)
        self.assertTrue(pm.matched)

    def test_exact_code_match(self):
        pm = check_product_match(["AC-S20", "M100"], "ac-s20")
        self.assertTrue(pm.matched)
        self.assertIn("AC-S20", pm.details)

    def test_substring_hint_match(self):
        pm = check_product_match(["Acme M100 Zigbee"], "M100")
        self.assertTrue(pm.matched)

    def test_mismatch_detected(self):
        pm = check_product_match(["AC-S20"], "Acme U100")
        self.assertFalse(pm.matched)
        self.assertIn("khác với", pm.details)


class SanitizeVisionResponseTests(unittest.TestCase):
    def test_parses_valid_json(self):
        raw = '{"fit_grade": 3, "rationale": "Khớp hoàn hảo với Acme M100", "relevance_score": 0.95, "context_explanation": "Cửa chính gỗ", "visual_subject": "Khóa Acme M100"}'
        out = sanitize_image_fit_response(raw)
        self.assertEqual(out["fit_grade"], 3)
        self.assertEqual(out["fit_label"], "Ideal")
        self.assertEqual(out["relevance_score"], 0.95)

    def test_clamps_out_of_bound_grades(self):
        raw = '{"fit_grade": 5, "relevance_score": 2.5}'
        out = sanitize_image_fit_response(raw)
        self.assertEqual(out["fit_grade"], 3)
        self.assertEqual(out["relevance_score"], 1.0)

    def test_recovers_from_json_embedded_in_text(self):
        raw = 'Đây là kết quả thẩm định:\n```json\n{"fit_grade": 2, "rationale": "Phù hợp bối cảnh"}\n```'
        out = sanitize_image_fit_response(raw)
        self.assertEqual(out["fit_grade"], 2)
        self.assertEqual(out["fit_label"], "Highly Relevant")


class EvaluateImageFitEngineTests(unittest.TestCase):
    def setUp(self):
        self.mock_gateway = MagicMock()
        self.mock_settings = MagicMock()

    def test_fail_closed_when_vision_call_fails(self):
        self.mock_gateway.shared_vision_config.side_effect = RuntimeError("Vision service unavailable")
        self.mock_gateway.select.return_value = [{
            "id": "11111111-1111-1111-1111-111111111111",
            "dimensions": {"width": 1000, "height": 1000},
            "thumbnail_path": "tenants/t1/thumb.webp",
        }]
        self.mock_gateway.create_signed_urls.return_value = {
            "tenants/t1/thumb.webp": "https://r2.test/signed.webp"
        }
        self.mock_gateway.fetch_confirmed_sku_matches.return_value = ["M100"]
        self.mock_gateway.recent_usage_on_channel.return_value = {"used": False}

        inp = EvaluateImageFitInput(
            article_text="Giới thiệu khóa điện tử thông minh.",
            media_asset_id="11111111-1111-1111-1111-111111111111",
            channel="facebook",
        )

        out = evaluate_image_fit(self.mock_gateway, self.mock_settings, inp)
        # Fail closed: must return grade 0 with error in rationale
        self.assertEqual(out.fit_grade, 0)
        self.assertEqual(out.fit_label, "Irrelevant")
        self.assertIn("AI Vision", out.rationale)

    @patch("verity_dam_mcp.image_fit.call_vision_fit")
    def test_demotes_grade_to_1_on_product_mismatch(self, mock_vision):
        # Vision thinks it's grade 3, but product hint does not match confirmed SKUs
        mock_vision.return_value = {
            "fit_grade": 3,
            "fit_label": "Ideal",
            "rationale": "Khóa cửa thông minh rất đẹp",
            "relevance_score": 0.95,
            "context_explanation": "Cửa gỗ chung cư",
            "visual_subject": "Khóa cửa Acme A100",
        }
        self.mock_gateway.shared_vision_config.return_value = {
            "base_url": "https://vision.test",
            "api_key": "test_key",
            "model": "gpt-4o-mini",
        }
        self.mock_gateway.select.return_value = [{
            "id": "11111111-1111-1111-1111-111111111111",
            "dimensions": {"width": 1080, "height": 1080},
            "thumbnail_path": "tenants/t1/thumb.webp",
        }]
        self.mock_gateway.create_signed_urls.return_value = {
            "tenants/t1/thumb.webp": "https://r2.test/signed.webp"
        }
        # Confirmed SKU is A100, but product hint requested M100
        self.mock_gateway.fetch_confirmed_sku_matches.return_value = ["A100"]
        self.mock_gateway.recent_usage_on_channel.return_value = {"used": False}

        inp = EvaluateImageFitInput(
            article_text="Bài viết giới thiệu Acme M100",
            media_asset_id="11111111-1111-1111-1111-111111111111",
            channel="facebook",
            product_hint="M100",
        )

        with patch("app.shared_vision_config._decrypt_api_key", return_value="decrypted-key"):
            out = evaluate_image_fit(self.mock_gateway, self.mock_settings, inp)

        # Mismatch must cap grade at 1
        self.assertEqual(out.fit_grade, 1)
        self.assertEqual(out.fit_label, "Marginally Relevant")
        self.assertIn("không khớp với sản phẩm", out.rationale)

    @patch("verity_dam_mcp.image_fit.call_vision_fit")
    def test_warns_when_asset_used_recently_on_channel(self, mock_vision):
        mock_vision.return_value = {
            "fit_grade": 3,
            "fit_label": "Ideal",
            "rationale": "Khớp hoàn hảo với sản phẩm và bài viết",
            "relevance_score": 0.98,
            "context_explanation": "Phòng khách sang trọng",
            "visual_subject": "Đèn trần Lumos Arwen",
        }
        self.mock_gateway.shared_vision_config.return_value = {
            "base_url": "https://vision.test",
            "api_key": "test_key",
            "model": "gpt-4o-mini",
        }
        self.mock_gateway.select.return_value = [{
            "id": "22222222-2222-2222-2222-222222222222",
            "dimensions": {"width": 1080, "height": 1080},
            "thumbnail_path": "tenants/t1/lumos.webp",
        }]
        self.mock_gateway.create_signed_urls.return_value = {
            "tenants/t1/lumos.webp": "https://r2.test/lumos.webp"
        }
        self.mock_gateway.fetch_confirmed_sku_matches.return_value = ["YLXD013"]
        self.mock_gateway.recent_usage_on_channel.return_value = {
            "used": True,
            "count": 2,
            "last_used_at": "2026-09-05T10:00:00Z",
        }

        inp = EvaluateImageFitInput(
            article_text="Đèn trần Lumos Arwen phong cách Bắc Âu hiện đại",
            media_asset_id="22222222-2222-2222-2222-222222222222",
            channel="facebook",
            product_hint="YLXD013",
        )

        with patch("app.shared_vision_config._decrypt_api_key", return_value="decrypted-key"):
            out = evaluate_image_fit(self.mock_gateway, self.mock_settings, inp)

        self.assertEqual(out.fit_grade, 3)
        self.assertTrue(out.already_used_recently.used)
        self.assertEqual(out.already_used_recently.usage_count, 2)
        self.assertIn("CẢNH BÁO: Đã dùng trên kênh facebook", out.rationale)
        self.assertIn("Lịch sử đăng bài", out.markdown_summary)


if __name__ == "__main__":
    unittest.main()
