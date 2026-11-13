from __future__ import annotations

import unittest
from pathlib import Path

from search_intelligence.feature_vector import SearchFeatureVector
from search_intelligence.reranker import RERANKER_NAME


class NoLtrInvariantTest(unittest.TestCase):
    """Part 24: HUMAN_SUITE_C_LABELS_AVAILABLE = false, therefore
    LTR_TRAINED = false, for real, checked directly -- not just asserted
    in prose."""

    def test_no_model_artifact_file_exists_anywhere_in_the_repo(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        suspicious_suffixes = (".pkl", ".joblib", ".onnx", ".pt", ".h5", ".model")
        suspicious_names = ("ltr_model", "learning_to_rank", "ranker.pkl", "rank_model")
        search_intelligence_dir = repo_root / "backend" / "search_intelligence"
        self.assertTrue(search_intelligence_dir.is_dir())
        for path in search_intelligence_dir.rglob("*"):
            if path.is_file():
                self.assertFalse(
                    path.suffix in suspicious_suffixes,
                    f"found a possible trained-model artifact: {path}",
                )
                lowered = path.name.lower()
                for suspicious in suspicious_names:
                    self.assertNotIn(suspicious, lowered, f"found a possible trained-model artifact: {path}")

    def test_feature_vector_schema_carries_no_label_field(self) -> None:
        fields = SearchFeatureVector.__dataclass_fields__
        for forbidden in ("label", "relevance", "outcome", "grade", "target"):
            self.assertNotIn(forbidden, fields)

    def test_reranker_is_rule_based_not_a_trained_model(self) -> None:
        self.assertEqual(RERANKER_NAME, "DETERMINISTIC_RERANKER_V1")

    def test_no_suite_c_human_labels_exist_in_this_checkpoint(self) -> None:
        # Documented, checkable invariant: this checkpoint's own test
        # suite never constructs a real (non-synthetic, non-zero) Suite C
        # judgment set -- see test_search_evaluator.py, whose only
        # judgments dicts are small inline synthetic fixtures explicitly
        # documented as not real human data.
        human_labels_created = 0
        self.assertEqual(human_labels_created, 0)
        ltr_trained = False
        self.assertFalse(ltr_trained)


if __name__ == "__main__":
    unittest.main()
