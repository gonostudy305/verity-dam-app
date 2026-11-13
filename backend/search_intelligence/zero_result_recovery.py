"""Deterministic zero-result recovery sequence.

Stage order (stop as soon as one stage returns enough candidates, per the
caller-supplied ``min_sufficient`` policy):

  1. ``ORIGINAL_ACCENTED_LEXICAL`` -- exactly what the user typed, lexical.
  2. ``ACCENT_FOLDED_LEXICAL`` -- diacritics stripped, lexical.
  3. ``BOUNDED_FUZZY_CORRECTION`` -- Checkpoint-1 typo candidates (bounded).
  4. ``REVIEWED_SYNONYMS`` -- the existing, human-curated production
     synonym table (not an LLM/ad-hoc expansion).
  5. ``FUTURE_SEMANTIC_CHANNEL`` -- optional; only attempted if the caller
     supplies a semantic-recovery function (none does today).

Every stage function receives the SAME, never-mutated
:class:`~search_intelligence.vietnamese_normalizer.NormalizedQuery` --
this module never rewrites/replaces the original query object; it only
sequences calls and records which stage actually produced results via
``recovery_stage_used``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Sequence

from .vietnamese_normalizer import NormalizedQuery


class RecoveryStage(str, Enum):
    ORIGINAL_ACCENTED_LEXICAL = "ORIGINAL_ACCENTED_LEXICAL"
    ACCENT_FOLDED_LEXICAL = "ACCENT_FOLDED_LEXICAL"
    BOUNDED_FUZZY_CORRECTION = "BOUNDED_FUZZY_CORRECTION"
    REVIEWED_SYNONYMS = "REVIEWED_SYNONYMS"
    FUTURE_SEMANTIC_CHANNEL = "FUTURE_SEMANTIC_CHANNEL"
    EXHAUSTED = "EXHAUSTED"  # no stage produced enough candidates


RecoveryFn = Callable[[NormalizedQuery], Sequence[str]]


@dataclass(frozen=True)
class RecoveryResult:
    recovery_stage_used: RecoveryStage
    candidate_asset_ids: tuple[str, ...] = field(default_factory=tuple)
    attempted_stages: tuple[RecoveryStage, ...] = field(default_factory=tuple)


def recover_zero_result(
    normalized: NormalizedQuery,
    *,
    accented_lexical_fn: RecoveryFn,
    folded_lexical_fn: RecoveryFn,
    fuzzy_fn: RecoveryFn,
    synonym_fn: RecoveryFn,
    semantic_fn: RecoveryFn | None = None,
    min_sufficient: int = 1,
) -> RecoveryResult:
    """Try each stage in order against the SAME normalized query; stop at
    the first stage producing at least ``min_sufficient`` candidates."""

    stages: list[tuple[RecoveryStage, RecoveryFn]] = [
        (RecoveryStage.ORIGINAL_ACCENTED_LEXICAL, accented_lexical_fn),
        (RecoveryStage.ACCENT_FOLDED_LEXICAL, folded_lexical_fn),
        (RecoveryStage.BOUNDED_FUZZY_CORRECTION, fuzzy_fn),
        (RecoveryStage.REVIEWED_SYNONYMS, synonym_fn),
    ]
    if semantic_fn is not None:
        stages.append((RecoveryStage.FUTURE_SEMANTIC_CHANNEL, semantic_fn))

    attempted: list[RecoveryStage] = []
    for stage, stage_fn in stages:
        attempted.append(stage)
        candidates = tuple(stage_fn(normalized))
        if len(candidates) >= min_sufficient:
            return RecoveryResult(
                recovery_stage_used=stage,
                candidate_asset_ids=candidates,
                attempted_stages=tuple(attempted),
            )
    return RecoveryResult(
        recovery_stage_used=RecoveryStage.EXHAUSTED,
        candidate_asset_ids=(),
        attempted_stages=tuple(attempted),
    )
