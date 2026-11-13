from __future__ import annotations

import unittest

from search_intelligence.rrf_fusion import (
    HYBRID_BASELINE_RRF,
    RankedChannelHit,
    reciprocal_rank_fusion,
)


class RrfFormulaExactTest(unittest.TestCase):
    def test_frozen_baseline_config_values(self) -> None:
        self.assertEqual(HYBRID_BASELINE_RRF.rrf_k, 60)
        self.assertEqual(HYBRID_BASELINE_RRF.semantic_depth, 100)
        self.assertEqual(HYBRID_BASELINE_RRF.lexical_depth, 100)
        self.assertEqual(HYBRID_BASELINE_RRF.semantic_weight, 1.0)
        self.assertEqual(HYBRID_BASELINE_RRF.lexical_weight, 1.0)

    def test_exact_score_for_doc_in_both_channels(self) -> None:
        lexical = (RankedChannelHit(asset_id="a1", rank=1),)
        semantic = (RankedChannelHit(asset_id="a1", rank=1),)
        results = reciprocal_rank_fusion(lexical, semantic)
        expected = 1.0 / (60 + 1) + 1.0 / (60 + 1)
        self.assertAlmostEqual(results[0].rrf_score, expected)

    def test_lexical_only_doc_gets_only_lexical_term(self) -> None:
        lexical = (RankedChannelHit(asset_id="a1", rank=3),)
        semantic: tuple = ()
        results = reciprocal_rank_fusion(lexical, semantic)
        self.assertAlmostEqual(results[0].rrf_score, 1.0 / (60 + 3))
        self.assertTrue(results[0].present_in_lexical)
        self.assertFalse(results[0].present_in_semantic)

    def test_semantic_only_doc_gets_only_semantic_term(self) -> None:
        lexical: tuple = ()
        semantic = (RankedChannelHit(asset_id="a1", rank=2),)
        results = reciprocal_rank_fusion(lexical, semantic)
        self.assertAlmostEqual(results[0].rrf_score, 1.0 / (60 + 2))
        self.assertFalse(results[0].present_in_lexical)
        self.assertTrue(results[0].present_in_semantic)

    def test_higher_combined_rank_sorts_first(self) -> None:
        lexical = (RankedChannelHit(asset_id="low", rank=50), RankedChannelHit(asset_id="high", rank=1))
        semantic: tuple = ()
        results = reciprocal_rank_fusion(lexical, semantic)
        self.assertEqual(results[0].asset_id, "high")
        self.assertEqual(results[1].asset_id, "low")

    def test_deterministic_tiebreak_by_asset_id(self) -> None:
        lexical = (RankedChannelHit(asset_id="b", rank=1), RankedChannelHit(asset_id="a", rank=1))
        semantic: tuple = ()
        results = reciprocal_rank_fusion(lexical, semantic)
        self.assertEqual([r.asset_id for r in results], ["a", "b"])

    def test_depth_cutoff_excludes_ranks_beyond_depth(self) -> None:
        from search_intelligence.rrf_fusion import HybridBaselineConfig

        config = HybridBaselineConfig(rrf_k=60, semantic_depth=100, lexical_depth=2, semantic_weight=1.0, lexical_weight=1.0)
        lexical = (
            RankedChannelHit(asset_id="a1", rank=1),
            RankedChannelHit(asset_id="a2", rank=2),
            RankedChannelHit(asset_id="a3", rank=3),  # beyond lexical_depth=2, must be excluded
        )
        results = reciprocal_rank_fusion(lexical, (), config=config)
        self.assertNotIn("a3", [r.asset_id for r in results])

    def test_repeated_calls_are_deterministic(self) -> None:
        lexical = (RankedChannelHit(asset_id="a1", rank=1), RankedChannelHit(asset_id="a2", rank=2))
        semantic = (RankedChannelHit(asset_id="a2", rank=1),)
        first = reciprocal_rank_fusion(lexical, semantic)
        second = reciprocal_rank_fusion(lexical, semantic)
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
