import unittest
from app.contracts import (
    SkuDecision,
    _normalise_candidates,
    gate_sku_candidates,
    apply_consistency_gate,
    SKU_HIGH_CONFIDENCE,
    SKU_LOW_CONFIDENCE,
    SKU_AMBIGUITY_MARGIN,
    SKU_CONSISTENCY_PRIMARY_MIN,
    SKU_CONSISTENCY_SPREAD_MAX,
)


class TestSkuContracts(unittest.TestCase):
    def test_normalise_candidates_preserves_rpc_ranking_order(self):
        # The RPC owns the ranking; this function must never re-sort, only dedupe.
        # Note the input below is deliberately NOT similarity-descending: that shape
        # is a contract violation post-20260824200000 (see the two invariant tests
        # at the bottom of this file), and the point here is that _normalise_candidates
        # passes it through untouched rather than silently repairing it.
        raw_rpc_candidates = [
            {"sku": "TL-TABO-C200", "similarity": 0.8343},
            {"sku": "IPC-A42P-D", "similarity": 0.8829},
            {"sku": "CS-H1C", "similarity": 0.7950},
        ]
        normalized = _normalise_candidates(raw_rpc_candidates)
        
        self.assertEqual(len(normalized), 3)
        self.assertEqual(normalized[0]["sku"], "TL-TABO-C200")
        self.assertEqual(normalized[1]["sku"], "IPC-A42P-D")
        self.assertEqual(normalized[2]["sku"], "CS-H1C")

    def test_normalise_candidates_deduplicates_by_first_occurrence(self):
        raw_candidates = [
            {"sku": "TABO-C200", "similarity": 0.85},
            {"sku": "TABO-C200", "similarity": 0.80},
            {"sku": "IPC-A42P-D", "similarity": 0.75},
        ]
        normalized = _normalise_candidates(raw_candidates)
        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[0]["sku"], "TABO-C200")
        self.assertEqual(normalized[0]["similarity"], 0.85)

    def test_gate_sku_candidates_selects_rpc_winner(self):
        candidates = [
            {"sku": "TL-TABO-C200", "similarity": 0.92},
            {"sku": "IPC-A42P-D", "similarity": 0.80},
        ]
        decision = gate_sku_candidates(candidates)
        self.assertEqual(decision.sku, "TL-TABO-C200")
        self.assertEqual(decision.confidence_band, "high")
        self.assertFalse(decision.ambiguity_warning)

    def test_consistency_gate_demotes_on_weak_primary(self):
        initial_decision = SkuDecision(
            sku="IPC-A42P-D",
            confidence_band="high",
            similarity=0.8829,
            runner_up_similarity=0.82,
            margin=0.0629,
            ambiguity_warning=False,
            requires_reviewer_confirmation=False,
            candidates=(),
        )
        # Primary reference similarity is 0.7679 (< 0.80)
        gated = apply_consistency_gate(
            initial_decision,
            reference_similarities=[0.8829, 0.7679],
            primary_similarity=0.7679,
        )
        self.assertEqual(gated.confidence_band, "low")
        self.assertTrue(gated.requires_reviewer_confirmation)
        self.assertTrue(gated.consistency_note.startswith("primary_similarity="))

    def test_consistency_gate_demotes_on_large_spread(self):
        initial_decision = SkuDecision(
            sku="HEAPAPLVNAS0105",
            confidence_band="high",
            similarity=0.9775,
            runner_up_similarity=0.85,
            margin=0.1275,
            ambiguity_warning=False,
            requires_reviewer_confirmation=False,
            candidates=(),
        )
        # Spread is 0.9775 - 0.7836 = 0.1939 (> 0.08)
        gated = apply_consistency_gate(
            initial_decision,
            reference_similarities=[0.9775, 0.7836, 0.8258],
            primary_similarity=0.9775,
        )
        self.assertEqual(gated.confidence_band, "low")
        self.assertTrue(gated.requires_reviewer_confirmation)
        self.assertTrue(gated.consistency_note.startswith("reference_spread="))

    def test_consistency_gate_passes_tight_references(self):
        initial_decision = SkuDecision(
            sku="IPC-A22EP-D-V2",
            confidence_band="high",
            similarity=0.9679,
            runner_up_similarity=0.90,
            margin=0.0679,
            ambiguity_warning=False,
            requires_reviewer_confirmation=False,
            candidates=(),
        )
        gated = apply_consistency_gate(
            initial_decision,
            reference_similarities=[0.9679, 0.9520],
            primary_similarity=0.9679,
        )
        self.assertEqual(gated.confidence_band, "high")
        self.assertFalse(gated.requires_reviewer_confirmation)
        self.assertEqual(gated.consistency_note, "consistent_across_references")


class TestSkuRankingInvariant(unittest.TestCase):
    """match_sku_reference_candidates must report the same quantity it ranked by.

    20260824200000_unify_sku_matching_similarity_score.sql established this so
    that ``similarity`` is monotone decreasing and ``margin`` is never negative.
    20260824213000_embedding_profile_provenance.sql reverted it while adding the
    provenance filters (returned ``max_sim`` but ordered by the primary-weighted
    blend); that revert is fixed in the same file. These tests pin the Python
    side of the contract so a future RPC rewrite is caught here.
    """

    def test_margin_non_negative_when_rpc_contract_holds(self):
        candidates = [
            {"sku": "IPC-A42P-D", "similarity": 0.9104},
            {"sku": "TL-TABO-C200", "similarity": 0.8163},
            {"sku": "CS-H1C", "similarity": 0.8012},
        ]
        decision = gate_sku_candidates(candidates)
        self.assertEqual(decision.sku, "IPC-A42P-D")
        self.assertIsNotNone(decision.margin)
        self.assertGreaterEqual(decision.margin, 0.0)
        self.assertAlmostEqual(decision.margin, 0.9104 - 0.8163, places=6)
        self.assertGreater(decision.margin, SKU_AMBIGUITY_MARGIN)
        self.assertFalse(decision.ambiguity_warning)
        self.assertFalse(decision.requires_reviewer_confirmation)

    def test_out_of_order_rpc_output_fails_safe_to_reviewer(self):
        # Shape produced by the reverted RPC: row 2 outscores row 1 because the
        # ordering used a different quantity than the one reported. Nothing here
        # auto-fills a wrong SKU -- the negative margin trips the ambiguity flag,
        # so the failure mode is over-flagging for review, never a silent bad
        # match. Asserted explicitly so the safe direction stays deliberate.
        candidates = [
            {"sku": "IPC-A42P-D", "similarity": 0.8663},
            {"sku": "TL-TABO-C200", "similarity": 0.9104},
        ]
        decision = gate_sku_candidates(candidates)
        self.assertEqual(decision.sku, "IPC-A42P-D")
        self.assertLess(decision.margin, 0.0)
        self.assertTrue(decision.ambiguity_warning)
        self.assertTrue(decision.requires_reviewer_confirmation)


if __name__ == "__main__":
    unittest.main()
