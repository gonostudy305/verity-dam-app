from __future__ import annotations

import unittest

from search_intelligence.lexical_scorer import score_document
from search_intelligence.search_document import SearchDocument
from search_intelligence.vietnamese_normalizer import normalize_query


class LexicalScorerTest(unittest.TestCase):
    def test_exact_title_phrase_scores_higher_than_partial_coverage(self) -> None:
        normalized = normalize_query("khóa thông minh")
        exact = score_document(
            SearchDocument(asset_id="a", title="khóa thông minh Verity"), normalized
        )
        partial = score_document(SearchDocument(asset_id="b", title="thông tin sản phẩm"), normalized)
        self.assertGreater(exact.total, partial.total)

    def test_score_breakdown_is_explainable_not_opaque(self) -> None:
        normalized = normalize_query("acme khóa")
        result = score_document(
            SearchDocument(asset_id="a", title="khóa cửa Acme", brand="Acme"), normalized
        )
        self.assertGreater(result.total, 0.0)
        self.assertTrue(result.breakdown)
        self.assertTrue(all(isinstance(key, str) for key in result.breakdown))

    def test_accent_folded_match_still_scores_something(self) -> None:
        normalized = normalize_query("khoa thong minh")  # unaccented
        result = score_document(SearchDocument(asset_id="a", title="khóa thông minh"), normalized)
        self.assertGreater(result.total, 0.0)

    def test_no_match_scores_zero(self) -> None:
        normalized = normalize_query("hoàn toàn không liên quan gì cả")
        result = score_document(SearchDocument(asset_id="a", title="Acme M100"), normalized)
        self.assertEqual(result.total, 0.0)
        self.assertEqual(result.breakdown, {})

    def test_sku_field_weighted_higher_than_caption_field(self) -> None:
        normalized = normalize_query("hr-21")
        sku_match = score_document(SearchDocument(asset_id="a", sku="HR-21"), normalized)
        caption_match = score_document(SearchDocument(asset_id="b", suggested_caption="hr-21 in the background"), normalized)
        self.assertGreater(sku_match.total, caption_match.total)

    def test_keywords_field_is_scored(self) -> None:
        normalized = normalize_query("zigbee")
        result = score_document(SearchDocument(asset_id="a", keywords=("zigbee", "smart lock")), normalized)
        self.assertGreater(result.total, 0.0)

    def test_empty_query_scores_zero(self) -> None:
        normalized = normalize_query("")
        result = score_document(SearchDocument(asset_id="a", title="anything"), normalized)
        self.assertEqual(result.total, 0.0)


if __name__ == "__main__":
    unittest.main()
