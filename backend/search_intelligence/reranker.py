"""``DETERMINISTIC_RERANKER_V1`` -- an explicitly rule-based reranker.

This is NOT machine learning -- never call it that. It is a fixed,
explainable, deterministic combination of signals already computed by the
other Checkpoint-2 modules (exact/entity tier, field-weighted lexical
score, fuzzy-correction confidence, RRF fusion score, entity overlap). Its
purpose is twofold: (1) a strong, explainable production-candidate
ordering today, and (2) a feature generator whose inputs are exactly the
columns :mod:`search_intelligence.feature_vector` schema-fies for a future
Learning-to-Rank model -- no such model is trained here (see the package
docstring's hard ML boundary; Suite C human labels do not exist yet).

Tier dominance (:class:`~search_intelligence.exact_channel.RankTier`) is
absolute: two candidates in different tiers are NEVER reordered by score,
only candidates within the same tier are. This mirrors the exact channel's
own "never a +999999 hack" design (see that module's docstring) at the
reranking layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .exact_channel import ExactSignals, RankTier
from .typo_model import TypoCandidate

RERANKER_NAME = "DETERMINISTIC_RERANKER_V1"

# CANDIDATE_WEIGHTS_ONLY (placeholder, not production truth -- see
# lexical_scorer.py's identical disclaimer) for combining the
# already-computed per-candidate scores WITHIN one rank tier.
RERANK_WEIGHTS_ONLY: dict[str, float] = {
    "lexical_score": 1.0,
    "fuzzy_confidence": 0.5,
    "rrf_score": 10.0,
    "entity_overlap": 1.0,
}


@dataclass(frozen=True)
class RerankCandidate:
    """Every already-computed signal for one candidate document, handed to
    the reranker. Nothing here is computed BY the reranker -- it only
    combines what the exact/lexical/fuzzy/RRF layers already produced."""

    asset_id: str
    rank_tier: RankTier
    exact_signals: ExactSignals
    lexical_score: float
    fuzzy_confidence: float = 0.0  # max confidence among fuzzy-correction variants that surfaced this doc, 0.0 if none
    fuzzy_candidate: TypoCandidate | None = None
    correction_used: str | None = None  # the corrected token actually used to retrieve this doc via the fuzzy channel, if any
    rrf_score: float = 0.0
    lexical_rank: int | None = None
    semantic_rank: int | None = None
    query_type: str | None = None
    entity_overlap: float = 0.0  # 0..1 fraction of the query's matched entities also present on this doc's own fields


@dataclass(frozen=True)
class RankExplanation:
    """Admin/debug-only explanation of one final ranking decision -- never
    exposed to ordinary viewers (see Part 16/permission notes: ranking
    explanation is not a permission surface, it must simply never be shown
    to a non-privileged caller)."""

    final_rank: int
    ranking_tier: str
    lexical_rank: int | None
    semantic_rank: int | None
    rrf_score: float
    exact_signals: ExactSignals
    fuzzy_signal: TypoCandidate | None
    correction_used: str | None
    feature_values: dict[str, float]
    reranker_contribution: dict[str, float]


@dataclass(frozen=True)
class RerankedResult:
    asset_id: str
    final_rank: int
    ranking_tier: RankTier
    combined_score: float
    explanation: RankExplanation


def _combined_score(candidate: RerankCandidate, weights: dict[str, float] | None = None) -> float:
    w = weights if weights is not None else RERANK_WEIGHTS_ONLY
    return (
        candidate.lexical_score * w["lexical_score"]
        + candidate.fuzzy_confidence * w["fuzzy_confidence"]
        + candidate.rrf_score * w["rrf_score"]
        + candidate.entity_overlap * w["entity_overlap"]
    )


def rerank(
    candidates: list[RerankCandidate] | tuple[RerankCandidate, ...],
    weights: dict[str, float] | None = None,
) -> tuple[RerankedResult, ...]:
    """Deterministically order candidates: tier first (never overridden by
    score), then combined score descending, then ``asset_id`` as a stable,
    fully-deterministic final tiebreaker (never left to input order)."""

    w = weights if weights is not None else RERANK_WEIGHTS_ONLY

    def sort_key(candidate: RerankCandidate) -> tuple[int, float, str]:
        return (candidate.rank_tier.value, -_combined_score(candidate, w), candidate.asset_id)

    ordered = sorted(candidates, key=sort_key)

    results: list[RerankedResult] = []
    for rank, candidate in enumerate(ordered, start=1):
        combined = _combined_score(candidate, w)
        contribution = {
            "lexical_score": candidate.lexical_score * w["lexical_score"],
            "fuzzy_confidence": candidate.fuzzy_confidence * w["fuzzy_confidence"],
            "rrf_score": candidate.rrf_score * w["rrf_score"],
            "entity_overlap": candidate.entity_overlap * w["entity_overlap"],
        }
        explanation = RankExplanation(
            final_rank=rank,
            ranking_tier=candidate.rank_tier.name,
            lexical_rank=candidate.lexical_rank,
            semantic_rank=candidate.semantic_rank,
            rrf_score=candidate.rrf_score,
            exact_signals=candidate.exact_signals,
            fuzzy_signal=candidate.fuzzy_candidate,
            correction_used=candidate.correction_used,
            feature_values={
                "lexical_score": candidate.lexical_score,
                "fuzzy_confidence": candidate.fuzzy_confidence,
                "rrf_score": candidate.rrf_score,
                "entity_overlap": candidate.entity_overlap,
            },
            reranker_contribution=contribution,
        )
        results.append(
            RerankedResult(
                asset_id=candidate.asset_id,
                final_rank=rank,
                ranking_tier=candidate.rank_tier,
                combined_score=combined,
                explanation=explanation,
            )
        )
    return tuple(results)
