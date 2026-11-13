import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.contracts import apply_brand_conflict_gate, gate_sku_candidates


def _low_decision():
    # similarity 0.72 sits in the "low" band: SKU kept as a review-required proposal.
    return gate_sku_candidates([{"sku": "LLG414", "similarity": 0.72}])


class TestBrandConflictGate(unittest.TestCase):
    def test_different_visible_brand_withholds_the_sku(self):
        decision = _low_decision()
        self.assertEqual(decision.sku, "LLG414")
        gated = apply_brand_conflict_gate(decision, "THERMOS", 0.9, "LOCKNLOCK")
        self.assertIsNone(gated.sku)
        self.assertEqual(gated.confidence_band, "unmatched")
        self.assertTrue(gated.requires_reviewer_confirmation)
        self.assertIn("brand_conflict", gated.consistency_note or "")
        # Candidates stay visible to the reviewer.
        self.assertEqual(gated.candidates, decision.candidates)

    def test_same_brand_with_different_spelling_is_kept(self):
        for spelling in ("Lock&Lock", "LOCK & LOCK", "LocknLock", "lock and lock"):
            gated = apply_brand_conflict_gate(_low_decision(), spelling, 0.9, "LOCKNLOCK")
            self.assertEqual(gated.sku, "LLG414", spelling)

    def test_unknown_blank_or_low_confidence_brand_never_triggers(self):
        for brand, confidence in (("unknown", 0.9), ("", 0.9), (None, 0.9), ("THERMOS", 0.2)):
            gated = apply_brand_conflict_gate(_low_decision(), brand, confidence, "LOCKNLOCK")
            self.assertEqual(gated.sku, "LLG414", (brand, confidence))

    def test_missing_catalog_brand_never_triggers(self):
        gated = apply_brand_conflict_gate(_low_decision(), "THERMOS", 0.9, None)
        self.assertEqual(gated.sku, "LLG414")

    def test_no_sku_decision_is_unchanged(self):
        decision = gate_sku_candidates([])
        self.assertIs(apply_brand_conflict_gate(decision, "THERMOS", 0.9, "LOCKNLOCK"), decision)


if __name__ == "__main__":
    unittest.main()
