"""Semantic channel adapter -- INTERFACE ONLY. Does not invoke SigLIP2.

This module defines the boundary a future semantic retriever must satisfy
to be fused with the lexical/fuzzy channels -- it does not call, load, or
activate any real model, and it does not read
``embedding_spaces``/``asset_embeddings`` or any other production table.
The canonical future space id (``verity-siglip2-b32-256-webli-v1``, 768-d,
``timm/ViT-B-32-SigLIP2-256``) is taken from the already-frozen
``plans/2026-08-28-siglip2-versioned-space-migration/plan.md`` candidate
spec (§ "Target model") purely so this adapter's validation has a real
value to check against -- reproducing that plan's own frozen numbers is
not the same as activating anything from it. SigLIP2 is NOT activated by
this checkpoint; see ``search_intelligence/__init__.py`` for the full
production boundary this offline library respects.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Protocol, Sequence

from .vietnamese_normalizer import NormalizedQuery

# Reproduced from the ALREADY-FROZEN migration plan's candidate spec, not
# invented here. This checkpoint does not activate SigLIP2 or write to any
# embedding_spaces row -- these constants exist only so
# validate_semantic_hits() has a concrete space id/dimension to check a
# future retriever's output against.
CANONICAL_FUTURE_SEMANTIC_SPACE = "verity-siglip2-b32-256-webli-v1"
CANONICAL_FUTURE_SEMANTIC_DIMENSION = 768


@dataclass(frozen=True)
class SemanticHit:
    """One result a semantic retriever returned for one query."""

    asset_id: str
    semantic_score: float
    semantic_rank: int
    space_id: str


class SemanticRetriever(Protocol):
    """Interface a future real (SigLIP2-backed) retriever must implement.

    No implementation of this protocol exists in this checkpoint -- the
    production model is never invoked. A future Checkpoint 3+ integration
    can plug a real implementation in here without changing any caller of
    :func:`validate_semantic_hits`/the fusion layer.
    """

    def retrieve(self, normalized: NormalizedQuery, top_k: int) -> Sequence[SemanticHit]: ...


class SemanticAdapterError(ValueError):
    """Raised when a semantic retriever's output fails validation."""


def validate_semantic_hits(
    hits: Sequence[SemanticHit],
    *,
    expected_space_id: str = CANONICAL_FUTURE_SEMANTIC_SPACE,
    expected_dimension: int | None = None,
    actual_dimension: int | None = None,
) -> tuple[SemanticHit, ...]:
    """Validate (never silently accept) a semantic retriever's raw output.

    Rejects, by raising :class:`SemanticAdapterError`:

    * a wrong/unexpected ``space_id`` (any hit not from ``expected_space_id``);
    * a wrong embedding dimension (when the caller supplies both
      ``expected_dimension`` and the retriever's ``actual_dimension`` --
      this adapter never receives raw vectors, only the retriever's
      self-reported dimension, so this check is a contract assertion, not
      a vector-shape check);
    * a NaN or infinite ``semantic_score``;
    * duplicate ``asset_id`` values across the hit list.

    Returns the hits unchanged (as a tuple) when everything validates --
    this function never mutates a score or reorders hits; it only accepts
    or rejects.
    """

    if expected_dimension is not None and actual_dimension is not None and actual_dimension != expected_dimension:
        raise SemanticAdapterError(
            f"semantic retriever dimension mismatch: expected {expected_dimension}, got {actual_dimension}"
        )

    seen_asset_ids: set[str] = set()
    for hit in hits:
        if hit.space_id != expected_space_id:
            raise SemanticAdapterError(
                f"semantic hit for asset {hit.asset_id!r} came from space {hit.space_id!r}, expected {expected_space_id!r}"
            )
        if math.isnan(hit.semantic_score) or math.isinf(hit.semantic_score):
            raise SemanticAdapterError(f"semantic hit for asset {hit.asset_id!r} has non-finite score {hit.semantic_score!r}")
        if hit.asset_id in seen_asset_ids:
            raise SemanticAdapterError(f"duplicate semantic hit for asset {hit.asset_id!r}")
        seen_asset_ids.add(hit.asset_id)

    return tuple(hits)


@dataclass(frozen=True)
class NullSemanticRetriever:
    """A retriever that always returns no results.

    This is the only :class:`SemanticRetriever` implementation that exists
    in this checkpoint -- it lets the fusion layer (Part 7) be exercised
    end-to-end today (lexical-only + "semantic returned nothing") without
    ever touching a real model. A real implementation is future work.
    """

    def retrieve(self, normalized: NormalizedQuery, top_k: int) -> tuple[SemanticHit, ...]:
        return ()
