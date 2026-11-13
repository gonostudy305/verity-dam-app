from __future__ import annotations

import unittest

from search_intelligence.exact_channel import ExactSignals, RankTier
from search_intelligence.reranker import RERANKER_NAME, RerankCandidate, rerank


def _candidate(asset_id: str, tier: RankTier, **kwargs) -> RerankCandidate:
    return RerankCandidate(
        asset_id=asset_id,
        rank_tier=tier,
        exact_signals=ExactSignals(),
        lexical_score=kwargs.pop("lexical_score", 0.0),
        **kwargs,
    )


class DeterministicRerankerTest(unittest.TestCase):
    def test_reranker_is_explicitly_not_called_machine_learning(self) -> None:
        self.assertEqual(RERANKER_NAME, "DETERMINISTIC_RERANKER_V1")
        self.assertNotIn("machine learning", RERANKER_NAME.lower())
        self.assertNotIn("ml", RERANKER_NAME.lower().split("_"))

    def test_higher_tier_always_beats_lower_tier_regardless_of_score(self) -> None:
        low_tier_high_score = _candidate("low", RankTier.TIER_4_RELEVANCE, lexical_score=1000.0)
        high_tier_low_score = _candidate("high", RankTier.TIER_0_EXACT_SKU, lexical_score=0.0)
        results = rerank([low_tier_high_score, high_tier_low_score])
        self.assertEqual(results[0].asset_id, "high")
        self.assertEqual(results[0].final_rank, 1)

    def test_within_same_tier_higher_score_wins(self) -> None:
        a = _candidate("a", RankTier.TIER_4_RELEVANCE, lexical_score=5.0)
        b = _candidate("b", RankTier.TIER_4_RELEVANCE, lexical_score=1.0)
        results = rerank([b, a])
        self.assertEqual(results[0].asset_id, "a")

    def test_deterministic_asset_id_tiebreak(self) -> None:
        a = _candidate("z", RankTier.TIER_4_RELEVANCE, lexical_score=1.0)
        b = _candidate("a", RankTier.TIER_4_RELEVANCE, lexical_score=1.0)
        results = rerank([a, b])
        self.assertEqual(results[0].asset_id, "a")
        self.assertEqual(results[1].asset_id, "z")

    def test_repeated_calls_are_repeatable(self) -> None:
        candidates = [
            _candidate("a", RankTier.TIER_2_EXACT_TITLE_PHRASE, lexical_score=2.0),
            _candidate("b", RankTier.TIER_0_EXACT_SKU, lexical_score=0.5),
            _candidate("c", RankTier.TIER_4_RELEVANCE, lexical_score=9.0),
        ]
        first = rerank(candidates)
        second = rerank(candidates)
        self.assertEqual([r.asset_id for r in first], [r.asset_id for r in second])

    def test_final_rank_is_1_indexed_and_sequential(self) -> None:
        candidates = [_candidate(str(i), RankTier.TIER_4_RELEVANCE, lexical_score=float(i)) for i in range(5)]
        results = rerank(candidates)
        self.assertEqual([r.final_rank for r in results], [1, 2, 3, 4, 5])

    def test_explanation_exposes_every_required_field(self) -> None:
        candidate = _candidate(
            "a",
            RankTier.TIER_0_EXACT_SKU,
            lexical_score=1.0,
            rrf_score=0.02,
            entity_overlap=0.5,
            lexical_rank=1,
            semantic_rank=None,
        )
        result = rerank([candidate])[0]
        explanation = result.explanation
        self.assertEqual(explanation.final_rank, 1)
        self.assertEqual(explanation.ranking_tier, "TIER_0_EXACT_SKU")
        self.assertEqual(explanation.lexical_rank, 1)
        self.assertIsNone(explanation.semantic_rank)
        self.assertIn("lexical_score", explanation.feature_values)
        self.assertIn("lexical_score", explanation.reranker_contribution)


if __name__ == "__main__":
    unittest.main()
