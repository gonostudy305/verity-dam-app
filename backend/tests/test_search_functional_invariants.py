from __future__ import annotations

import unittest

from search_intelligence.functional_invariants import run_functional_invariants
from search_intelligence.search_document import SearchDocument


class FunctionalInvariantsTest(unittest.TestCase):
    """Part 18: deterministic invariants only -- explicitly NOT a
    relevance-quality claim (no Suite C human labels exist)."""

    def test_full_functional_invariant_suite_passes(self) -> None:
        verity_lock = SearchDocument(asset_id="verity-lock", sku="HR-21", title="Khóa thông minh Verity", brand="Verity")
        acme_camera = SearchDocument(asset_id="acme-cam", title="Camera Acme G3", brand="Acme")
        noise_doc = SearchDocument(asset_id="noise", title="hoàn toàn không liên quan")
        lock_title_doc = SearchDocument(asset_id="lock-title", title="khóa cửa thông minh Verity")

        report = run_functional_invariants(
            sku_fixtures=[("HR-21", [verity_lock, noise_doc])],
            accent_parity_fixtures=[("khóa cửa thông minh", "khoa cua thong minh", [lock_title_doc, noise_doc])],
            determinism_fixtures=[
                ("aqraa camera", [acme_camera, noise_doc]),
                ("khóa thông minh", [verity_lock, lock_title_doc, noise_doc]),
            ],
        )

        for check in report.checks:
            self.assertTrue(check.passed, f"{check.name} failed: {check.detail}")
        self.assertTrue(report.all_passed)
        self.assertEqual(report.label, "FUNCTIONAL_INVARIANTS")

    def test_report_never_claims_relevance_quality(self) -> None:
        report = run_functional_invariants()
        self.assertEqual(report.label, "FUNCTIONAL_INVARIANTS")
        self.assertNotIn("relevance", report.label.lower())
        self.assertNotIn("quality", report.label.lower())


if __name__ == "__main__":
    unittest.main()
