from __future__ import annotations

import unittest

from search_intelligence.entity_extractor import extract_entities
from search_intelligence.query_classifier import QueryType, RuleBasedQueryClassifier
from search_intelligence.vietnamese_normalizer import normalize_query


def _classify(raw_query: str):
    normalized = normalize_query(raw_query)
    entities = extract_entities(normalized)
    return RuleBasedQueryClassifier().classify(normalized, entities)


class QueryClassifierTest(unittest.TestCase):
    def test_exact_sku_query(self) -> None:
        result = _classify("HR-21")
        self.assertEqual(result.query_type, QueryType.EXACT_SKU)
        self.assertGreaterEqual(result.confidence, 0.9)

    def test_brand_product_query(self) -> None:
        result = _classify("camera acme")
        self.assertEqual(result.query_type, QueryType.BRAND_PRODUCT)

    def test_product_category_query(self) -> None:
        result = _classify("khóa cửa thông minh")
        self.assertEqual(result.query_type, QueryType.PRODUCT_CATEGORY)

    def test_attribute_feature_query(self) -> None:
        result = _classify("vân tay")
        self.assertEqual(result.query_type, QueryType.ATTRIBUTE_FEATURE)

    def test_scene_use_case_query(self) -> None:
        result = _classify("phòng khách")
        self.assertEqual(result.query_type, QueryType.SCENE_USE_CASE)

    def test_empty_query_is_unknown(self) -> None:
        result = _classify("")
        self.assertEqual(result.query_type, QueryType.UNKNOWN)
        self.assertIn("empty_query", result.signals)

    def test_unknown_fallback_for_unrecognized_short_query(self) -> None:
        result = _classify("xyz123")
        self.assertEqual(result.query_type, QueryType.UNKNOWN)

    def test_natural_language_query(self) -> None:
        result = _classify("tôi muốn tìm sản phẩm giá rẻ nhất")
        self.assertEqual(result.query_type, QueryType.NATURAL_LANGUAGE)

    def test_classification_is_deterministic(self) -> None:
        first = _classify("camera acme trong nhà")
        second = _classify("camera acme trong nhà")
        self.assertEqual(first, second)

    def test_sku_signal_takes_precedence_over_brand(self) -> None:
        # even with a brand token present, an exact SKU hit wins.
        result = _classify("acme HR-21")
        self.assertEqual(result.query_type, QueryType.EXACT_SKU)


class ScenePrecedenceOverCategoryTest(unittest.TestCase):
    """Part 0C fix: a space/installation-context signal must win over a bare
    category/feature signal (EXACT_SKU still always wins overall)."""

    def test_robot_vacuum_plus_living_room_is_scene_not_category(self) -> None:
        result = _classify("robot hút bụi phòng khách")
        self.assertEqual(result.query_type, QueryType.SCENE_USE_CASE)

    def test_camera_outdoor_is_scene_not_category(self) -> None:
        result = _classify("camera ngoài trời")
        self.assertEqual(result.query_type, QueryType.SCENE_USE_CASE)

    def test_lock_plus_front_door_is_scene_not_category(self) -> None:
        result = _classify("khóa cửa chính")
        self.assertEqual(result.query_type, QueryType.SCENE_USE_CASE)

    def test_exact_sku_still_overrides_scene_signal(self) -> None:
        # A real SKU code alongside a space/category word must still win.
        result = _classify("HR-21 phòng khách")
        self.assertEqual(result.query_type, QueryType.EXACT_SKU)


if __name__ == "__main__":
    unittest.main()
