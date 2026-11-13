"""Reciprocal Rank Fusion (RRF) -- the frozen hybrid baseline.

``HYBRID_BASELINE_RRF`` is the one canonical, un-tuned fusion
configuration this checkpoint ships: semantic depth 100, lexical depth
100, ``rrf_k=60``, weights 1.0/1.0. There is no tuning surface yet -- any
weight/depth/k change is future work, gated on real evaluation data.

The formula is deterministic: for each asset present in either ranked
list, ``score = weight_l / (k + lexical_rank) + weight_s / (k +
semantic_rank)`` (a term is omitted, not zero-filled, when the asset is
absent from that channel -- an asset absent from a channel gets no credit
from it, rather than a synthetic worst-case rank). Assets present in
both channels, lexical-only, or semantic-only are all handled by the same
formula; the only difference is which term(s) apply.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

RRF_K = 60
SEMANTIC_DEPTH = 100
LEXICAL_DEPTH = 100
SEMANTIC_WEIGHT = 1.0
LEXICAL_WEIGHT = 1.0


@dataclass(frozen=True)
class HybridBaselineConfig:
    rrf_k: int = RRF_K
    semantic_depth: int = SEMANTIC_DEPTH
    lexical_depth: int = LEXICAL_DEPTH
    semantic_weight: float = SEMANTIC_WEIGHT
    lexical_weight: float = LEXICAL_WEIGHT


HYBRID_BASELINE_RRF = HybridBaselineConfig()


@dataclass(frozen=True)
class RankedChannelHit:
    """One asset's 1-indexed rank within a single channel's ranked list."""

    asset_id: str
    rank: int


@dataclass(frozen=True)
class RrfResult:
    asset_id: str
    rrf_score: float
    lexical_rank: int | None = None
    semantic_rank: int | None = None

    @property
    def present_in_lexical(self) -> bool:
        return self.lexical_rank is not None

    @property
    def present_in_semantic(self) -> bool:
        return self.semantic_rank is not None


def reciprocal_rank_fusion(
    lexical_ranked: Sequence[RankedChannelHit],
    semantic_ranked: Sequence[RankedChannelHit],
    *,
    config: HybridBaselineConfig = HYBRID_BASELINE_RRF,
) -> tuple[RrfResult, ...]:
    """Deterministic RRF over two ranked channels. Pure function."""

    lexical_by_id = {hit.asset_id: hit.rank for hit in lexical_ranked[: config.lexical_depth]}
    semantic_by_id = {hit.asset_id: hit.rank for hit in semantic_ranked[: config.semantic_depth]}

    ordered_ids: list[str] = []
    seen: set[str] = set()
    for asset_id in list(lexical_by_id.keys()) + list(semantic_by_id.keys()):
        if asset_id not in seen:
            seen.add(asset_id)
            ordered_ids.append(asset_id)

    results: list[RrfResult] = []
    for asset_id in ordered_ids:
        lexical_rank = lexical_by_id.get(asset_id)
        semantic_rank = semantic_by_id.get(asset_id)
        score = 0.0
        if lexical_rank is not None:
            score += config.lexical_weight / (config.rrf_k + lexical_rank)
        if semantic_rank is not None:
            score += config.semantic_weight / (config.rrf_k + semantic_rank)
        results.append(
            RrfResult(asset_id=asset_id, rrf_score=score, lexical_rank=lexical_rank, semantic_rank=semantic_rank)
        )

    # Deterministic ordering: highest score first, asset_id as a stable tiebreaker.
    results.sort(key=lambda result: (-result.rrf_score, result.asset_id))
    return tuple(results)
