"""Entity / SKU extraction over a normalized query.

Every vocabulary this module matches against comes from
:mod:`search_intelligence.vocabulary` (real, observed repository data only
-- see that module's docstring for exact provenance per list).

SKU detection is deliberately conservative: it is an EXACT match only
(after case/whitespace normalization) against the real, frozen SKU
universe. It never typo-corrects or fuzzy-matches a token into a different
SKU code -- that would silently change which product a user is asking
about. Fuzzy correction (handled by :mod:`search_intelligence.typo_model`)
must consult :func:`is_known_sku_token` and skip correction for anything
that already exactly identifies a SKU.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .vietnamese_normalizer import NormalizedQuery, strip_diacritics, token_spans
from .vocabulary import (
    BRAND_VOCABULARY,
    CATEGORY_KEYWORDS,
    FEATURE_VOCABULARY,
    INSTALLATION_CONTEXT_VOCABULARY,
    PROTOCOL_VOCABULARY,
    SKU_INDEX,
    SPACE_VOCABULARY,
    SkuRecord,
)


@dataclass(frozen=True)
class EntityMatch:
    """One matched entity, always explainable."""

    value: str
    matched_text: str
    confidence: float
    source: str


@dataclass(frozen=True)
class SkuEntityMatch:
    record: SkuRecord
    matched_text: str
    confidence: float = 1.0
    source: str = "calibration_v2_sku_universe_v2"


@dataclass(frozen=True)
class EntityExtractionResult:
    skus: tuple[SkuEntityMatch, ...] = field(default_factory=tuple)
    brands: tuple[EntityMatch, ...] = field(default_factory=tuple)
    categories: tuple[EntityMatch, ...] = field(default_factory=tuple)
    spaces: tuple[EntityMatch, ...] = field(default_factory=tuple)
    installation_contexts: tuple[EntityMatch, ...] = field(default_factory=tuple)
    features: tuple[EntityMatch, ...] = field(default_factory=tuple)
    protocols: tuple[EntityMatch, ...] = field(default_factory=tuple)

    def has_any(self) -> bool:
        return bool(
            self.skus or self.brands or self.categories or self.spaces
            or self.installation_contexts or self.features or self.protocols
        )


def _normalize_for_match(text: str) -> str:
    return " ".join(text.split()).casefold()


def _boundary_pattern(key: str) -> re.Pattern[str]:
    escaped = re.escape(key)
    prefix = r"\b" if key[:1].isalnum() else ""
    suffix = r"\b" if key[-1:].isalnum() else ""
    return re.compile(f"{prefix}{escaped}{suffix}")


def is_known_sku_token(candidate: str) -> SkuRecord | None:
    """Exact (case/whitespace normalized) SKU lookup -- no fuzzy fallback.

    Returns the matching :class:`~search_intelligence.vocabulary.SkuRecord`
    only on an exact match; ``None`` otherwise. This is the guard the typo
    model must consult before ever proposing a fuzzy correction for a token.
    """

    return SKU_INDEX.get(_normalize_for_match(candidate))


def find_sku_matches(normalized: NormalizedQuery) -> tuple[SkuEntityMatch, ...]:
    haystack = _normalize_for_match(normalized.accented_normalized)
    if not haystack:
        return ()
    matches: list[SkuEntityMatch] = []
    seen: set[str] = set()
    # Longest key first so a longer real SKU ("DEMO-016") is preferred over
    # any shorter key that might otherwise appear to be a substring of it.
    for key, record in sorted(SKU_INDEX.items(), key=lambda item: (-len(item[0]), item[0])):
        if key in seen:
            continue
        if _boundary_pattern(key).search(haystack):
            matches.append(SkuEntityMatch(record=record, matched_text=key))
            seen.add(key)
    return tuple(matches)


def find_sku_token_spans(normalized: NormalizedQuery) -> tuple[tuple[int, int], ...]:
    """Character ``(start, end)`` spans in ``normalized.accented_normalized``
    for each exact SKU occurrence matched by :func:`find_sku_matches`.

    A real SKU/model span can cover more than one token (e.g. ``"l20
    ultra"``, ``"DEMO-014"``, ``"PX-80x(8MP+2MP,4mm)"``) --
    this returns the raw character span so callers can determine exactly
    which token indexes fall inside it, rather than assuming a SKU is
    always exactly one token.
    """

    haystack = normalized.accented_normalized
    if not haystack:
        return ()
    spans: list[tuple[int, int]] = []
    seen: set[str] = set()
    for key, _record in sorted(SKU_INDEX.items(), key=lambda item: (-len(item[0]), item[0])):
        if key in seen:
            continue
        match = _boundary_pattern(key).search(haystack)
        if match is not None:
            spans.append((match.start(), match.end()))
            seen.add(key)
    return tuple(spans)


def protected_token_indexes(normalized: NormalizedQuery) -> tuple[int, ...]:
    """Token indexes (into ``normalized.tokens``) that fall inside an exact
    SKU match span and therefore must NEVER be typo-corrected.

    This is the multi-token counterpart to :func:`is_known_sku_token`: a
    single-token guard alone is not enough for a real SKU/model span like
    ``"DEMO-016"`` or ``"DEMO-014"`` where no individual token is
    itself a complete SKU code, but the WHOLE matched span is an exact,
    conservative SKU identification and none of its constituent tokens may
    be fuzzy-corrected into something else. Returned as a sorted tuple of
    ints (not a set) so downstream consumers get a deterministic,
    explainable representation.
    """

    sku_spans = find_sku_token_spans(normalized)
    if not sku_spans:
        return ()
    spans = token_spans(normalized.accented_normalized)
    protected: set[int] = set()
    for index, (tok_start, tok_end) in enumerate(spans):
        for sku_start, sku_end in sku_spans:
            if tok_start < sku_end and tok_end > sku_start:
                protected.add(index)
                break
    return tuple(sorted(protected))


def _find_phrase_matches(
    normalized: NormalizedQuery, vocabulary: dict[str, str] | tuple[str, ...], *, source: str
) -> tuple[EntityMatch, ...]:
    accented_haystack = _normalize_for_match(normalized.accented_normalized)
    folded_haystack = _normalize_for_match(normalized.accent_folded)
    items = vocabulary.items() if isinstance(vocabulary, dict) else ((entry, entry) for entry in vocabulary)
    matches: list[EntityMatch] = []
    seen_values: set[str] = set()
    for phrase, value in items:
        if value in seen_values:
            continue
        phrase_norm = _normalize_for_match(phrase)
        if not phrase_norm:
            continue
        if _boundary_pattern(phrase_norm).search(accented_haystack):
            matches.append(EntityMatch(value=value, matched_text=phrase, confidence=1.0, source=source))
            seen_values.add(value)
            continue
        folded_phrase = _normalize_for_match(strip_diacritics(phrase))
        if folded_phrase and _boundary_pattern(folded_phrase).search(folded_haystack):
            matches.append(EntityMatch(value=value, matched_text=phrase, confidence=0.85, source=source))
            seen_values.add(value)
    return tuple(matches)


def find_brand_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, BRAND_VOCABULARY, source="brand_taxonomy")


def find_category_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, CATEGORY_KEYWORDS, source="category_keywords")


def find_space_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, SPACE_VOCABULARY, source="space_taxonomy")


def find_installation_context_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, INSTALLATION_CONTEXT_VOCABULARY, source="installation_context")


def find_feature_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, FEATURE_VOCABULARY, source="feature_terms")


def find_protocol_matches(normalized: NormalizedQuery) -> tuple[EntityMatch, ...]:
    return _find_phrase_matches(normalized, PROTOCOL_VOCABULARY, source="protocol_terms")


def extract_entities(normalized: NormalizedQuery) -> EntityExtractionResult:
    """Run every entity extractor against one normalized query."""

    return EntityExtractionResult(
        skus=find_sku_matches(normalized),
        brands=find_brand_matches(normalized),
        categories=find_category_matches(normalized),
        spaces=find_space_matches(normalized),
        installation_contexts=find_installation_context_matches(normalized),
        features=find_feature_matches(normalized),
        protocols=find_protocol_matches(normalized),
    )
