from __future__ import annotations

import math
import unittest

from search_intelligence.semantic_adapter import (
    CANONICAL_FUTURE_SEMANTIC_DIMENSION,
    CANONICAL_FUTURE_SEMANTIC_SPACE,
    NullSemanticRetriever,
    SemanticAdapterError,
    SemanticHit,
    validate_semantic_hits,
)
from search_intelligence.vietnamese_normalizer import normalize_query


class SemanticAdapterValidationTest(unittest.TestCase):
    def test_valid_hits_pass_through_unchanged(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=0.9, semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
            SemanticHit(asset_id="a2", semantic_score=0.5, semantic_rank=2, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        self.assertEqual(validate_semantic_hits(hits), hits)

    def test_wrong_space_rejected(self) -> None:
        hits = (SemanticHit(asset_id="a1", semantic_score=0.9, semantic_rank=1, space_id="some-other-space"),)
        with self.assertRaises(SemanticAdapterError):
            validate_semantic_hits(hits)

    def test_nan_score_rejected(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=float("nan"), semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        with self.assertRaises(SemanticAdapterError):
            validate_semantic_hits(hits)

    def test_infinite_score_rejected(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=math.inf, semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        with self.assertRaises(SemanticAdapterError):
            validate_semantic_hits(hits)

    def test_duplicate_asset_id_rejected(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=0.9, semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
            SemanticHit(asset_id="a1", semantic_score=0.8, semantic_rank=2, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        with self.assertRaises(SemanticAdapterError):
            validate_semantic_hits(hits)

    def test_wrong_dimension_rejected(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=0.9, semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        with self.assertRaises(SemanticAdapterError):
            validate_semantic_hits(
                hits,
                expected_dimension=CANONICAL_FUTURE_SEMANTIC_DIMENSION,
                actual_dimension=512,
            )

    def test_matching_dimension_accepted(self) -> None:
        hits = (
            SemanticHit(asset_id="a1", semantic_score=0.9, semantic_rank=1, space_id=CANONICAL_FUTURE_SEMANTIC_SPACE),
        )
        validated = validate_semantic_hits(
            hits,
            expected_dimension=CANONICAL_FUTURE_SEMANTIC_DIMENSION,
            actual_dimension=CANONICAL_FUTURE_SEMANTIC_DIMENSION,
        )
        self.assertEqual(validated, hits)

    def test_empty_hits_are_valid(self) -> None:
        self.assertEqual(validate_semantic_hits(()), ())


class NullSemanticRetrieverTest(unittest.TestCase):
    def test_null_retriever_never_invokes_a_real_model_and_returns_nothing(self) -> None:
        retriever = NullSemanticRetriever()
        normalized = normalize_query("khóa thông minh")
        self.assertEqual(retriever.retrieve(normalized, top_k=100), ())


if __name__ == "__main__":
    unittest.main()
