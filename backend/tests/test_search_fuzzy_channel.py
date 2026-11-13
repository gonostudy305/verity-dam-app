from __future__ import annotations

import unittest

from search_intelligence.fuzzy_channel import generate_fuzzy_query_variants
from search_intelligence.vietnamese_normalizer import normalize_query


class FuzzyChannelBoundsTest(unittest.TestCase):
    def test_variants_bounded_by_max_rewritten_queries(self) -> None:
        normalized = normalize_query("khoa thong minh cua")  # several correctable tokens
        result = generate_fuzzy_query_variants(normalized, max_rewritten_queries=2)
        self.assertLessEqual(len(result.variants), 2)

    def test_pool_bounded_by_max_fuzzy_pool(self) -> None:
        normalized = normalize_query("khoa thong minh cua")
        result = generate_fuzzy_query_variants(normalized, max_fuzzy_pool=1, max_rewritten_queries=10)
        self.assertLessEqual(len(result.variants), 1)

    def test_truncated_flag_set_when_bounds_are_hit(self) -> None:
        normalized = normalize_query("khoa thong minh cua")
        result = generate_fuzzy_query_variants(normalized, max_rewritten_queries=1)
        self.assertTrue(result.truncated)

    def test_no_truncation_when_few_candidates(self) -> None:
        normalized = normalize_query("robot")  # already correct, no candidates
        result = generate_fuzzy_query_variants(normalized)
        self.assertFalse(result.truncated)
        self.assertEqual(result.variants, ())

    def test_search_original_always_true(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = generate_fuzzy_query_variants(normalized)
        self.assertTrue(result.search_original)

    def test_no_duplicate_rewritten_queries(self) -> None:
        normalized = normalize_query("khoa thong minh cua")
        result = generate_fuzzy_query_variants(normalized, max_rewritten_queries=10, max_fuzzy_pool=50)
        rewritten = [variant.rewritten_query for variant in result.variants]
        self.assertEqual(len(rewritten), len(set(rewritten)))

    def test_variant_never_equals_original_query(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = generate_fuzzy_query_variants(normalized)
        for variant in result.variants:
            self.assertNotEqual(variant.rewritten_query, normalized.accented_normalized)

    def test_sku_tokens_are_never_rewritten_into_a_variant(self) -> None:
        normalized = normalize_query("khoa HR-21 Verity")
        result = generate_fuzzy_query_variants(normalized)
        for variant in result.variants:
            self.assertNotEqual(variant.original_token, "hr-21")

    def test_each_variant_exposes_full_typo_explanation(self) -> None:
        normalized = normalize_query("khoa thong minh")
        result = generate_fuzzy_query_variants(normalized)
        for variant in result.variants:
            self.assertTrue(variant.candidate.edit_type)
            self.assertGreaterEqual(variant.candidate.confidence, 0.0)
            self.assertTrue(variant.candidate.vocabulary_source)


if __name__ == "__main__":
    unittest.main()
