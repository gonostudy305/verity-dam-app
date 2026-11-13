from __future__ import annotations

import unittest

from search_intelligence.feature_vector import SearchFeatureVector


class SearchFeatureVectorTest(unittest.TestCase):
    def test_defaults_are_all_neutral_zero_or_unknown(self) -> None:
        vector = SearchFeatureVector(query_id="q1", asset_id="a1")
        self.assertEqual(vector.exact_sku, 0.0)
        self.assertEqual(vector.query_type, "UNKNOWN")
        self.assertIsNone(vector.semantic_rank)
        self.assertIsNone(vector.lexical_rank)

    def test_as_dict_round_trips_every_field(self) -> None:
        vector = SearchFeatureVector(query_id="q1", asset_id="a1", exact_sku=1.0, rrf_score=0.02)
        as_dict = vector.as_dict()
        self.assertEqual(as_dict["query_id"], "q1")
        self.assertEqual(as_dict["exact_sku"], 1.0)
        self.assertEqual(as_dict["rrf_score"], 0.02)

    def test_no_outcome_label_field_exists(self) -> None:
        fields = SearchFeatureVector.__dataclass_fields__
        for forbidden in ("label", "relevance", "outcome", "grade", "target"):
            self.assertNotIn(forbidden, fields)


if __name__ == "__main__":
    unittest.main()
