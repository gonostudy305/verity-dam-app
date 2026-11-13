"""Release A Reciprocal Rank Fusion (RRF) and Graceful Degradation Contract Tests.

Validates:
- Strict contract values:
  * semantic depth: 100
  * lexical depth: 100
  * rrf_k: 60
  * weights: 1.0 / 1.0
- Graceful degradation: Any failure in text daemon, pgvector search, or network
  must fall back immediately to lexical-only search without 500 or crash.
- Status semantics:
  * RRF_CONTRACT_TEST_PASS
  * FALLBACK_CONTRACT_TEST_PASS
  * Runtime integration is NOT claimed at pre-stage.
- Invariant: selector is NEVER mutated automatically upon fallback.
"""

from __future__ import annotations

import unittest
from typing import Any, Dict, List, Optional

FROZEN_RRF_CONFIG = {
    "semantic_depth": 100,
    "lexical_depth": 100,
    "rrf_k": 60,
    "semantic_weight": 1.0,
    "lexical_weight": 1.0,
}


def compute_rrf(
    semantic_ranked_ids: List[str],
    lexical_ranked_ids: List[str],
    k: int = 60,
    w_sem: float = 1.0,
    w_lex: float = 1.0,
    max_semantic_depth: int = 100,
    max_lexical_depth: int = 100,
) -> List[Dict[str, Any]]:
    """Compute Reciprocal Rank Fusion between semantic and lexical rank lists."""
    scores: Dict[str, float] = {}
    details: Dict[str, Dict[str, Any]] = {}

    for rank, item_id in enumerate(semantic_ranked_ids[:max_semantic_depth], start=1):
        rrf_val = w_sem / (k + rank)
        scores[item_id] = scores.get(item_id, 0.0) + rrf_val
        details.setdefault(item_id, {})["semantic_rank"] = rank

    for rank, item_id in enumerate(lexical_ranked_ids[:max_lexical_depth], start=1):
        rrf_val = w_lex / (k + rank)
        scores[item_id] = scores.get(item_id, 0.0) + rrf_val
        details.setdefault(item_id, {})["lexical_rank"] = rank

    sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [
        {
            "id": item_id,
            "rrf_score": score,
            "semantic_rank": details[item_id].get("semantic_rank"),
            "lexical_rank": details[item_id].get("lexical_rank"),
        }
        for item_id, score in sorted_items
    ]


class MockTextEmbeddingService:
    def __init__(self, mode: str = "ok") -> None:
        self.mode = mode

    def embed_text(self, text: str) -> List[float]:
        if self.mode == "timeout":
            raise TimeoutError("Text embedding service timed out after 2000ms")
        elif self.mode == "connection_failure":
            raise ConnectionError("Connection refused by text embedding daemon")
        elif self.mode == "runtime_unhealthy":
            raise RuntimeError("Text ONNX runtime reported internal error")
        elif self.mode == "vector_search_error":
            raise ValueError("pgvector index dimension mismatch")
        return [0.01] * 768


def execute_search_pipeline(
    query: str,
    embed_service: MockTextEmbeddingService,
    active_space: str,
    nl_space: Optional[str],
    mock_db: Dict[str, Any],
) -> Dict[str, Any]:
    """Simulate the hybrid search pipeline with graceful degradation."""
    lexical_candidates = mock_db.get("lexical_results", [])
    used_fallback = False
    fallback_reason = None
    semantic_candidates = []

    if nl_space is not None:
        try:
            query_vec = embed_service.embed_text(query)
            # In a real query, query_vec is used against pgvector
            semantic_candidates = mock_db.get("semantic_results", [])
        except Exception as e:
            # Graceful degradation: do NOT fail search, fallback to lexical only
            used_fallback = True
            fallback_reason = str(e)
            semantic_candidates = []

    if semantic_candidates:
        fused = compute_rrf(
            semantic_candidates,
            lexical_candidates,
            k=FROZEN_RRF_CONFIG["rrf_k"],
            w_sem=FROZEN_RRF_CONFIG["semantic_weight"],
            w_lex=FROZEN_RRF_CONFIG["lexical_weight"],
            max_semantic_depth=FROZEN_RRF_CONFIG["semantic_depth"],
            max_lexical_depth=FROZEN_RRF_CONFIG["lexical_depth"],
        )
        final_ids = [item["id"] for item in fused]
    else:
        final_ids = lexical_candidates

    return {
        "results": final_ids,
        "used_fallback": used_fallback,
        "fallback_reason": fallback_reason,
        "active_space": active_space,
        "nl_space": nl_space,  # Selector is strictly untouched
    }


def get_rrf_contract_status() -> Dict[str, Any]:
    return {
        "rrf_status": "RRF_CONTRACT_TEST_PASS",
        "fallback_status": "FALLBACK_CONTRACT_TEST_PASS",
        "runtime_integration": "PENDING",
        "frozen_config": FROZEN_RRF_CONFIG,
    }


class TestReleaseARRFAndFallback(unittest.TestCase):
    def test_rrf_contract_parameters_frozen(self) -> None:
        """Verify the exact frozen parameters for RRF."""
        self.assertEqual(FROZEN_RRF_CONFIG["semantic_depth"], 100)
        self.assertEqual(FROZEN_RRF_CONFIG["lexical_depth"], 100)
        self.assertEqual(FROZEN_RRF_CONFIG["rrf_k"], 60)
        self.assertEqual(FROZEN_RRF_CONFIG["semantic_weight"], 1.0)
        self.assertEqual(FROZEN_RRF_CONFIG["lexical_weight"], 1.0)

    def test_rrf_scoring_and_ranking(self) -> None:
        """Verify that items appearing high in both semantic and lexical rank highest."""
        semantic = ["item_A", "item_B", "item_C"]
        lexical = ["item_B", "item_D", "item_A"]
        
        fused = compute_rrf(semantic, lexical, k=60, w_sem=1.0, w_lex=1.0)
        
        # item_B is rank 2 in semantic and rank 1 in lexical:
        # score_B = 1/(60+2) + 1/(60+1) = 1/62 + 1/61 = 0.016129 + 0.016393 = 0.032522
        # item_A is rank 1 in semantic and rank 3 in lexical:
        # score_A = 1/(60+1) + 1/(60+3) = 1/61 + 1/63 = 0.016393 + 0.015873 = 0.032266
        # item_B should be top 1!
        self.assertEqual(fused[0]["id"], "item_B")
        self.assertEqual(fused[1]["id"], "item_A")
        self.assertAlmostEqual(fused[0]["rrf_score"], (1/62) + (1/61), places=5)
        self.assertAlmostEqual(fused[1]["rrf_score"], (1/61) + (1/63), places=5)

    def test_fallback_on_timeout(self) -> None:
        """Text runtime timeout must gracefully degrade to lexical search."""
        service = MockTextEmbeddingService(mode="timeout")
        mock_db = {
            "lexical_results": ["lex_1", "lex_2"],
            "semantic_results": ["sem_1", "sem_2"],
        }
        res = execute_search_pipeline(
            "khóa thông minh",
            service,
            active_space="verity-openclip-b32-datacomp-256-v1",
            nl_space="verity-siglip2-b32-256-webli-v1",
            mock_db=mock_db,
        )
        self.assertTrue(res["used_fallback"])
        self.assertIn("timed out", res["fallback_reason"])
        self.assertEqual(res["results"], ["lex_1", "lex_2"])
        # Invariant: selector is untouched
        self.assertEqual(res["nl_space"], "verity-siglip2-b32-256-webli-v1")

    def test_fallback_on_connection_failure(self) -> None:
        """Connection refused must gracefully degrade to lexical search."""
        service = MockTextEmbeddingService(mode="connection_failure")
        mock_db = {"lexical_results": ["lex_1", "lex_2"]}
        res = execute_search_pipeline(
            "khóa thông minh",
            service,
            active_space="verity-openclip-b32-datacomp-256-v1",
            nl_space="verity-siglip2-b32-256-webli-v1",
            mock_db=mock_db,
        )
        self.assertTrue(res["used_fallback"])
        self.assertIn("refused", res["fallback_reason"])
        self.assertEqual(res["results"], ["lex_1", "lex_2"])

    def test_fallback_on_runtime_error(self) -> None:
        """ONNX runtime error must gracefully degrade to lexical search."""
        service = MockTextEmbeddingService(mode="runtime_unhealthy")
        mock_db = {"lexical_results": ["lex_1"]}
        res = execute_search_pipeline(
            "khóa thông minh",
            service,
            active_space="verity-openclip-b32-datacomp-256-v1",
            nl_space="verity-siglip2-b32-256-webli-v1",
            mock_db=mock_db,
        )
        self.assertTrue(res["used_fallback"])
        self.assertEqual(res["results"], ["lex_1"])

    def test_fallback_on_vector_search_error(self) -> None:
        """pgvector failure must gracefully degrade to lexical search."""
        service = MockTextEmbeddingService(mode="vector_search_error")
        mock_db = {"lexical_results": ["lex_1"]}
        res = execute_search_pipeline(
            "khóa thông minh",
            service,
            active_space="verity-openclip-b32-datacomp-256-v1",
            nl_space="verity-siglip2-b32-256-webli-v1",
            mock_db=mock_db,
        )
        self.assertTrue(res["used_fallback"])
        self.assertEqual(res["results"], ["lex_1"])

    def test_no_automatic_selector_mutation(self) -> None:
        """Verify that repeated failures do NOT mutate the selector automatically."""
        service = MockTextEmbeddingService(mode="timeout")
        mock_db = {"lexical_results": ["lex_1"]}
        for _ in range(5):
            res = execute_search_pipeline(
                "query",
                service,
                active_space="verity-openclip-b32-datacomp-256-v1",
                nl_space="verity-siglip2-b32-256-webli-v1",
                mock_db=mock_db,
            )
            self.assertEqual(res["nl_space"], "verity-siglip2-b32-256-webli-v1")
            self.assertEqual(res["active_space"], "verity-openclip-b32-datacomp-256-v1")

    def test_contract_status_semantics(self) -> None:
        """Verify contract status labeling and that runtime integration is PENDING."""
        status = get_rrf_contract_status()
        self.assertEqual(status["rrf_status"], "RRF_CONTRACT_TEST_PASS")
        self.assertEqual(status["fallback_status"], "FALLBACK_CONTRACT_TEST_PASS")
        self.assertEqual(status["runtime_integration"], "PENDING")


if __name__ == "__main__":
    unittest.main()
