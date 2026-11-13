import unittest

try:
    from importers.google_drive.orchestrator import resolve_embedding_sku
except ModuleNotFoundError:
    from backend.importers.google_drive.orchestrator import resolve_embedding_sku


class TestDriveSkuMatching(unittest.TestCase):
    def test_unambiguous_high_match_is_accepted(self):
        sku, decision = resolve_embedding_sku([
            {"sku": "LF-RF21", "similarity": 0.94},
            {"sku": "LF-RF22", "similarity": 0.80},
        ])
        self.assertEqual(sku, "LF-RF21")
        self.assertEqual(decision["confidence_band"], "high")
        self.assertFalse(decision["requires_reviewer_confirmation"])

    def test_low_match_is_retained_for_review_without_assignment(self):
        sku, decision = resolve_embedding_sku([
            {"sku": "LF-RF21", "similarity": 0.78},
            {"sku": "LF-RF22", "similarity": 0.60},
        ])
        self.assertIsNone(sku)
        self.assertEqual(decision["confidence_band"], "low")
        self.assertTrue(decision["requires_reviewer_confirmation"])

    def test_ambiguous_high_match_is_retained_for_review(self):
        sku, decision = resolve_embedding_sku([
            {"sku": "LF-RF21", "similarity": 0.94},
            {"sku": "LF-RF22", "similarity": 0.90},
        ])
        self.assertIsNone(sku)
        self.assertEqual(decision["confidence_band"], "high")
        self.assertTrue(decision["ambiguity_warning"])
        self.assertTrue(decision["requires_reviewer_confirmation"])


if __name__ == "__main__":
    unittest.main()
