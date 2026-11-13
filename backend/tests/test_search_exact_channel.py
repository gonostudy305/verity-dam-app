from __future__ import annotations

import unittest

from search_intelligence.entity_extractor import extract_entities
from search_intelligence.exact_channel import RankTier, compute_exact_signals, rank_tier
from search_intelligence.search_document import SearchDocument
from search_intelligence.vietnamese_normalizer import normalize_query


def _signals(raw_query: str, document: SearchDocument):
    normalized = normalize_query(raw_query)
    entities = extract_entities(normalized)
    return compute_exact_signals(document, normalized, entities)


class ExactSkuTierTest(unittest.TestCase):
    def test_exact_sku_query_gives_tier_0(self) -> None:
        document = SearchDocument(asset_id="a1", sku="HR-21", brand="Verity", title="Khoa Verity")
        signals = _signals("HR-21", document)
        self.assertTrue(signals.exact_sku)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_multi_token_sku_still_gives_tier_0(self) -> None:
        document = SearchDocument(asset_id="a2", sku="DEMO-016", brand="DRIFT", title="Drift DEMO-016")
        signals = _signals("robot DEMO-016", document)
        self.assertTrue(signals.exact_sku)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_exact_sku_beats_everything_else_regardless_of_score_magnitude(self) -> None:
        # A document with a real exact SKU match must never lose tier
        # precedence to any lexical score comparison hack.
        exact = _signals("HR-21", SearchDocument(asset_id="a", sku="HR-21", title="not a great title match"))
        non_exact = _signals(
            "HR-21", SearchDocument(asset_id="b", sku="OTHER-1", title="HR-21 HR-21 HR-21 HR-21 HR-21")
        )
        self.assertEqual(rank_tier(exact), RankTier.TIER_0_EXACT_SKU)
        self.assertNotEqual(rank_tier(non_exact), RankTier.TIER_0_EXACT_SKU)
        self.assertLess(rank_tier(exact).value, rank_tier(non_exact).value)


class CatalogWideExactSkuTest(unittest.TestCase):
    """Gap A regression: Tier-0 exact SKU must work for ANY catalog SKU,
    not just the frozen 40-SKU benchmark vocabulary (see PR #31 review
    5109220215). These SKUs are deliberately NOT in
    entity_extractor.SKU_INDEX -- they exercise the new direct,
    catalog-agnostic bounded-span comparison in compute_exact_signals,
    not the vocabulary-based entity match."""

    def test_catalog_sku_outside_frozen_vocabulary_gives_tier_0(self) -> None:
        document = SearchDocument(asset_id="c1", sku="ZX-9981-NOTINVOCAB", title="Some camera")
        signals = _signals("ZX-9981-NOTINVOCAB", document)
        self.assertTrue(signals.exact_sku)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_catalog_sku_with_brand_prefix_in_query_gives_tier_0(self) -> None:
        document = SearchDocument(asset_id="c2", sku="ABC-123", title="Not in vocab either")
        signals = _signals("acme ABC-123", document)
        self.assertTrue(signals.exact_sku)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_punctuated_catalog_sku_gives_tier_0(self) -> None:
        document = SearchDocument(asset_id="c3", sku="PX-80x(8MP+2MP,4mm)", title="Camera 2 lens")
        signals = _signals("PX-80x(8MP+2MP,4mm)", document)
        self.assertTrue(signals.exact_sku)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_longer_sku_query_does_not_falsely_match_a_shorter_catalog_sku(self) -> None:
        # "ABC-123" must NOT be treated as an exact match for a document
        # whose own sku is "ABC-123" when the QUERY actually says
        # "ABC-1234" -- the character right after the would-be match ("4")
        # is alphanumeric, so this is a different, longer SKU code.
        document = SearchDocument(asset_id="c5", sku="ABC-123", title="Some product")
        signals = _signals("ABC-1234", document)
        self.assertFalse(signals.exact_sku)
        self.assertNotEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)

    def test_shorter_query_does_not_falsely_match_a_longer_catalog_sku(self) -> None:
        document = SearchDocument(asset_id="c6", sku="ABC-1234", title="Some other product")
        signals = _signals("ABC-123", document)
        self.assertFalse(signals.exact_sku)


class BrandAndTitleTierTest(unittest.TestCase):
    def test_brand_plus_sku_gives_brand_model_tier(self) -> None:
        document = SearchDocument(asset_id="a3", sku="HR-21", brand="Verity", title="Khoa Verity")
        signals = _signals("Verity HR-21", document)
        self.assertTrue(signals.exact_brand_model)
        self.assertEqual(rank_tier(signals), RankTier.TIER_0_EXACT_SKU)  # SKU still wins even combined with brand

    def test_title_phrase_match_without_sku_gives_tier_2(self) -> None:
        document = SearchDocument(asset_id="a4", sku="UNRELATED", title="khóa cửa thông minh")
        signals = _signals("khóa cửa thông minh", document)
        self.assertFalse(signals.exact_sku)
        self.assertTrue(signals.exact_title_phrase)
        self.assertEqual(rank_tier(signals), RankTier.TIER_2_EXACT_TITLE_PHRASE)

    def test_brand_only_match_gives_tier_3(self) -> None:
        document = SearchDocument(asset_id="a5", sku="UNRELATED", brand="Acme", title="something else entirely")
        signals = _signals("acme", document)
        self.assertTrue(signals.exact_brand)
        self.assertFalse(signals.exact_sku)
        self.assertFalse(signals.exact_title_phrase)
        self.assertEqual(rank_tier(signals), RankTier.TIER_3_EXACT_BRAND)

    def test_no_signal_gives_relevance_tier(self) -> None:
        document = SearchDocument(asset_id="a6", title="completely unrelated document")
        signals = _signals("khóa thông minh", document)
        self.assertFalse(signals.any_exact())
        self.assertEqual(rank_tier(signals), RankTier.TIER_4_RELEVANCE)


if __name__ == "__main__":
    unittest.main()
