"""Runtime search ranking and retrieval configuration with in-memory TTL caching."""

from __future__ import annotations

import time
from typing import Any

DEFAULT_SEARCH_CONFIG: dict[str, Any] = {
    "rrf_k": 60,
    "semantic_weight": 1.0,
    "lexical_weight": 1.0,
    "mmr_lambda": 0.7,
    "mmr_pool_size": 40,
    "mmr_output_size": 20,
    "rerank_lexical": 1.0,
    "rerank_fuzzy": 0.5,
    "rerank_rrf": 10.0,
    "rerank_entity": 1.0,
    "semantic_enabled": True,
}

_cache: dict[str, Any] | None = None
_cache_at: float = 0.0
_CACHE_TTL_SECONDS = 60.0


def clear_search_config_cache() -> None:
    global _cache, _cache_at
    _cache = None
    _cache_at = 0.0


def load_search_config(repo: Any = None) -> dict[str, Any]:
    global _cache, _cache_at
    now = time.monotonic()
    if _cache is not None and now - _cache_at < _CACHE_TTL_SECONDS:
        return _cache

    if repo is not None:
        try:
            row = repo.fetch_one(
                "SELECT rrf_k, semantic_weight, lexical_weight, mmr_lambda, mmr_pool_size, "
                "mmr_output_size, rerank_lexical, rerank_fuzzy, rerank_rrf, rerank_entity, semantic_enabled "
                "FROM public.verity_search_config WHERE id = 1"
            )
            if row:
                raw_sem = row.get("semantic_enabled")
                parsed = {
                    "rrf_k": int(row.get("rrf_k") or DEFAULT_SEARCH_CONFIG["rrf_k"]),
                    "semantic_weight": float(row.get("semantic_weight") if row.get("semantic_weight") is not None else DEFAULT_SEARCH_CONFIG["semantic_weight"]),
                    "lexical_weight": float(row.get("lexical_weight") if row.get("lexical_weight") is not None else DEFAULT_SEARCH_CONFIG["lexical_weight"]),
                    "mmr_lambda": float(row.get("mmr_lambda") if row.get("mmr_lambda") is not None else DEFAULT_SEARCH_CONFIG["mmr_lambda"]),
                    "mmr_pool_size": int(row.get("mmr_pool_size") or DEFAULT_SEARCH_CONFIG["mmr_pool_size"]),
                    "mmr_output_size": int(row.get("mmr_output_size") or DEFAULT_SEARCH_CONFIG["mmr_output_size"]),
                    "rerank_lexical": float(row.get("rerank_lexical") if row.get("rerank_lexical") is not None else DEFAULT_SEARCH_CONFIG["rerank_lexical"]),
                    "rerank_fuzzy": float(row.get("rerank_fuzzy") if row.get("rerank_fuzzy") is not None else DEFAULT_SEARCH_CONFIG["rerank_fuzzy"]),
                    "rerank_rrf": float(row.get("rerank_rrf") if row.get("rerank_rrf") is not None else DEFAULT_SEARCH_CONFIG["rerank_rrf"]),
                    "rerank_entity": float(row.get("rerank_entity") if row.get("rerank_entity") is not None else DEFAULT_SEARCH_CONFIG["rerank_entity"]),
                    "semantic_enabled": (str(raw_sem).lower() == "true" or raw_sem is True) if raw_sem is not None else DEFAULT_SEARCH_CONFIG["semantic_enabled"],
                }
                _cache = parsed
                _cache_at = now
                return parsed
        except Exception:
            pass

    return dict(DEFAULT_SEARCH_CONFIG)
