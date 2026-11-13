from __future__ import annotations

import unittest

from search_intelligence.entity_extractor import (
    extract_entities,
    find_brand_matches,
    find_category_matches,
    find_sku_matches,
    is_known_sku_token,
)
from search_intelligence.vietnamese_normalizer import normalize_query


class ExactSkuGuardTest(unittest.TestCase):
    """Proves SKUs are matched exactly and never fuzzy-corrected into a
    different SKU -- the guard other modules (typo_model) rely on."""

    def test_known_sku_exact_match(self) -> None:
        record = is_known_sku_token("HR-21")
        self.assertIsNotNone(record)
        self.assertEqual(record.brand, "Verity")

    def test_known_sku_case_and_whitespace_insensitive(self) -> None:
        record = is_known_sku_token("  hr-21  ")
        self.assertIsNotNone(record)
        self.assertEqual(record.sku, "HR-21")

    def test_near_miss_sku_is_not_matched(self) -> None:
        # "HR-2" is one character short of the real "HR-21" -- must NOT match.
        self.assertIsNone(is_known_sku_token("HR-2"))
        self.assertIsNone(is_known_sku_token("HR-211"))

    def test_typo_of_sku_is_not_fuzzy_corrected_into_another_sku(self) -> None:
        # "HR-31" is not a real SKU and must not silently resolve to HR-21/HR-33.
        self.assertIsNone(is_known_sku_token("HR-31"))

    def test_find_sku_matches_within_full_query(self) -> None:
        normalized = normalize_query("mua khóa HR-21 Verity")
        matches = find_sku_matches(normalized)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].record.sku, "HR-21")

    def test_find_sku_matches_does_not_match_substring_of_longer_code(self) -> None:
        # "N200" is a real SKU; ensure it is not spuriously matched inside
        # an unrelated longer alphanumeric token.
        normalized = normalize_query("model n2001x không tồn tại")
        matches = find_sku_matches(normalized)
        self.assertEqual(matches, ())


class BrandExtractionTest(unittest.TestCase):
    def test_finds_real_brand_from_taxonomy(self) -> None:
        normalized = normalize_query("camera acme g3")
        matches = find_brand_matches(normalized)
        self.assertIn("Acme", [m.value for m in matches])

    def test_no_brand_false_positive_on_unrelated_query(self) -> None:
        normalized = normalize_query("phòng khách buổi tối")
        matches = find_brand_matches(normalized)
        self.assertEqual(matches, ())


class CategoryExtractionTest(unittest.TestCase):
    def test_finds_category_from_accented_keyword(self) -> None:
        normalized = normalize_query("khóa cửa vân tay")
        matches = find_category_matches(normalized)
        self.assertIn("Product_Line_A", [m.value for m in matches])

    def test_finds_category_from_unaccented_keyword_with_lower_confidence(self) -> None:
        normalized = normalize_query("khoa cua van tay")
        matches = find_category_matches(normalized)
        values = [m.value for m in matches]
        self.assertIn("Product_Line_A", values)
        match = next(m for m in matches if m.value == "Product_Line_A")
        self.assertLess(match.confidence, 1.0)


class FullExtractionTest(unittest.TestCase):
    def test_extract_entities_aggregates_all_matchers(self) -> None:
        normalized = normalize_query("camera acme trong nhà wifi")
        result = extract_entities(normalized)
        self.assertTrue(result.has_any())
        self.assertIn("Acme", [m.value for m in result.brands])
        self.assertIn("Product_Line_B", [m.value for m in result.categories])
        self.assertIn("trong nhà", [m.value for m in result.installation_contexts])
        self.assertIn("wifi", [m.value for m in result.protocols])

    def test_empty_query_has_no_entities(self) -> None:
        normalized = normalize_query("")
        result = extract_entities(normalized)
        self.assertFalse(result.has_any())


if __name__ == "__main__":
    unittest.main()
