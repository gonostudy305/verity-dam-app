"""Fuzzy channel -- consumes Checkpoint-1 typo candidates, bounded.

Every rewritten query variant this module produces carries the exact
:class:`~search_intelligence.typo_model.TypoCandidate` that justified it
(weighted edit cost, confidence, edit type -- accent/tone difference,
keyboard error, transposition, Telex residue, VNI residue). Expansion is
bounded at THREE independent points so a query with many low-confidence
per-token candidates can never combinatorially explode into an
unreasonable number of downstream lexical-scorer calls:

  1. ``max_candidates_per_token`` -- already enforced inside
     :func:`~search_intelligence.typo_model.correct_token` (per-token cap).
  2. ``max_fuzzy_pool`` -- a cap on the TOTAL candidate pool considered
     across every token in the query, cheapest-cost-first.
  3. ``max_rewritten_queries`` -- a cap on how many distinct rewritten
     query strings are actually produced from that pool.

Only ONE token is rewritten per variant (never a cross-product of
multiple simultaneous token corrections) -- this is itself the strongest
protection against combinatorial explosion, and matches the conservative
"search both original and correction candidates" default from Checkpoint 1
(:data:`~search_intelligence.typo_model.QueryCorrectionResult.search_original`).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .typo_model import (
    DEFAULT_MAX_CANDIDATES_PER_TOKEN,
    DEFAULT_MAX_NORMALIZED_COST,
    TypoCandidate,
    generate_query_candidates,
)
from .vietnamese_normalizer import NormalizedQuery

DEFAULT_MAX_FUZZY_POOL = 25
DEFAULT_MAX_REWRITTEN_QUERIES = 5


@dataclass(frozen=True)
class FuzzyQueryVariant:
    """One bounded, explainable rewritten-query candidate."""

    rewritten_query: str
    token_index: int
    original_token: str
    candidate: TypoCandidate


@dataclass(frozen=True)
class FuzzyExpansionResult:
    original_query: str
    variants: tuple[FuzzyQueryVariant, ...] = field(default_factory=tuple)
    truncated: bool = False
    total_candidates_considered: int = 0
    search_original: bool = True


def generate_fuzzy_query_variants(
    normalized: NormalizedQuery,
    *,
    vocabulary: dict[str, str] | None = None,
    max_candidates_per_token: int = DEFAULT_MAX_CANDIDATES_PER_TOKEN,
    max_normalized_cost: float = DEFAULT_MAX_NORMALIZED_COST,
    max_fuzzy_pool: int = DEFAULT_MAX_FUZZY_POOL,
    max_rewritten_queries: int = DEFAULT_MAX_REWRITTEN_QUERIES,
) -> FuzzyExpansionResult:
    """Bounded fuzzy query-variant generation.

    ``normalized.accented_normalized`` (the original query) is ALWAYS
    intended to be searched alongside whatever variants come back --
    ``search_original`` is exposed here (mirroring
    :class:`~search_intelligence.typo_model.QueryCorrectionResult`) purely
    so every call site can assert the invariant directly rather than
    re-deriving it.
    """

    correction_result = generate_query_candidates(
        normalized,
        vocabulary=vocabulary,
        max_candidates=max_candidates_per_token,
        max_normalized_cost=max_normalized_cost,
    )
    total_candidates = sum(len(candidates) for _, candidates in correction_result.per_token)

    pooled: list[tuple[int, str, TypoCandidate]] = [
        (index, token, candidate)
        for index, (token, candidates) in enumerate(correction_result.per_token)
        for candidate in candidates
    ]
    pooled.sort(key=lambda item: (item[2].normalized_cost, item[2].corrected_token))
    pool_truncated = len(pooled) > max_fuzzy_pool
    bounded_pool = pooled[:max_fuzzy_pool]

    tokens = list(normalized.tokens)
    seen_queries = {normalized.accented_normalized}
    all_variants: list[FuzzyQueryVariant] = []
    for index, token, candidate in bounded_pool:
        rewritten_tokens = list(tokens)
        rewritten_tokens[index] = candidate.corrected_token
        rewritten_query = " ".join(rewritten_tokens)
        if rewritten_query in seen_queries:
            continue
        seen_queries.add(rewritten_query)
        all_variants.append(
            FuzzyQueryVariant(
                rewritten_query=rewritten_query,
                token_index=index,
                original_token=token,
                candidate=candidate,
            )
        )

    variants_truncated = len(all_variants) > max_rewritten_queries
    variants = tuple(all_variants[:max_rewritten_queries])

    return FuzzyExpansionResult(
        original_query=normalized.accented_normalized,
        variants=variants,
        truncated=pool_truncated or variants_truncated,
        total_candidates_considered=total_candidates,
    )
