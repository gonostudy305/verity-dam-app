"""Exact/entity channel -- the highest-precision structural ranking signal.

A legitimate exact-SKU result must never lose Top1 to a high fuzzy/
semantic score. This module represents that precedence EXPLICITLY as a
:class:`RankTier` (an ``IntEnum`` compared before any relevance score),
not by adding an arbitrary huge constant (e.g. ``+999999``) to a score --
that kind of hack silently breaks the moment two exact hits need to be
told apart, or a future score scale changes. A tier is a structural fact
("this IS the SKU the user typed"), and structural facts must dominate a
continuous score by construction, not by magnitude.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from .entity_extractor import EntityExtractionResult
from .search_document import SearchDocument
from .vietnamese_normalizer import NormalizedQuery, strip_diacritics


class RankTier(IntEnum):
    """Lower value = higher precedence. Compared BEFORE any relevance
    score -- two documents in different tiers are never reordered by score;
    only documents within the same tier are ordered by score."""

    TIER_0_EXACT_SKU = 0
    TIER_1_EXACT_BRAND_MODEL = 1
    TIER_2_EXACT_TITLE_PHRASE = 2
    TIER_3_EXACT_BRAND = 3
    TIER_4_RELEVANCE = 4  # no structural exact signal fired; ordinary lexical/fuzzy/semantic ranking applies


def _normalize_for_match(text: str) -> str:
    return " ".join(text.split()).casefold()


def _bounded_exact_span_match(needle: str, haystack: str) -> bool:
    """Does ``needle`` appear as a COMPLETE, boundary-respecting span
    inside ``haystack``? Both are assumed already case-folded and
    whitespace-normalized (see ``_normalize_for_match``) -- punctuation is
    preserved and compared literally, never stripped.

    A match only counts if the character immediately before the match
    (if any) and immediately after it (if any) are NOT alphanumeric. This
    is what makes "ABC-123" match inside "acme ABC-123" (preceded by a
    space, followed by end-of-string) while correctly REJECTING "ABC-123"
    as a match inside "ABC-1234" (the character right after the would-be
    match, "4", is alphanumeric -- so it is a longer, different SKU, not
    the one the user typed).
    """

    if not needle:
        return False
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index == -1:
            return False
        end = index + len(needle)
        before_ok = index == 0 or not haystack[index - 1].isalnum()
        after_ok = end == len(haystack) or not haystack[end].isalnum()
        if before_ok and after_ok:
            return True
        start = index + 1


@dataclass(frozen=True)
class ExactSignals:
    """Every exact/entity signal this document produced against this query,
    each independently explainable (see the mission's required signal
    list: exact_sku, normalized_sku, exact_model, exact_brand_model,
    exact_title_phrase, exact_brand)."""

    exact_sku: bool = False
    normalized_sku: bool = False
    exact_model: bool = False
    exact_brand_model: bool = False
    exact_title_phrase: bool = False
    exact_brand: bool = False

    def any_exact(self) -> bool:
        return any(
            (
                self.exact_sku,
                self.normalized_sku,
                self.exact_model,
                self.exact_brand_model,
                self.exact_title_phrase,
                self.exact_brand,
            )
        )


def compute_exact_signals(
    document: SearchDocument, normalized: NormalizedQuery, entities: EntityExtractionResult
) -> ExactSignals:
    """Compare one document's real fields against the query's extracted
    entities/normalized forms. Pure function -- no DB, no side effects."""

    doc_sku_norm = _normalize_for_match(document.sku)
    query_sku_norms = {_normalize_for_match(match.record.sku) for match in entities.skus}
    # Two independent routes to an exact-SKU signal, deliberately kept
    # separate and OR'd together (never one replacing the other):
    #
    #  1. ``vocab_exact_sku`` -- the query matched a KNOWN entity in the
    #     frozen benchmark SKU vocabulary (``entity_extractor.SKU_INDEX``).
    #     This is what existed before this fix; it stays, since it is what
    #     drives ``entity_overlap``/entity-aware signals elsewhere.
    #  2. ``direct_exact_sku`` -- a CONSERVATIVE, catalog-agnostic direct
    #     comparison: does THIS document's own ``sku`` (whatever it is,
    #     frozen-vocabulary member or not) appear as a complete, bounded
    #     span in the query text? This is what makes Tier-0 exact-SKU
    #     matching work for ANY real catalog SKU, not just the 40 SKUs the
    #     offline benchmark vocabulary happens to know about -- see the
    #     module docstring and docs/search/VIETNAMESE_SEARCH_ARCHITECTURE.md
    #     for the production-correctness gap this closes.
    vocab_exact_sku = bool(doc_sku_norm) and doc_sku_norm in query_sku_norms
    query_text_norm = _normalize_for_match(normalized.accented_normalized)
    direct_exact_sku = bool(doc_sku_norm) and _bounded_exact_span_match(doc_sku_norm, query_text_norm)
    exact_sku = vocab_exact_sku or direct_exact_sku
    # "normalized_sku" is the same case/whitespace-normalized comparison as
    # exact_sku -- kept as its own explicit field because the mission's
    # signal list names it separately, and a future looser SKU-alias
    # normalization (e.g. stripping punctuation) could diverge from
    # exact_sku without diverging from this field.
    normalized_sku = exact_sku
    exact_model = exact_sku  # in this catalog the SKU code IS the model code; no separate model vocabulary exists yet

    doc_brand_fold = strip_diacritics(document.brand).casefold().strip()
    query_brand_folds = {strip_diacritics(match.value).casefold() for match in entities.brands}
    exact_brand = bool(doc_brand_fold) and doc_brand_fold in query_brand_folds

    exact_brand_model = exact_sku and exact_brand

    haystack_title_accented = _normalize_for_match(document.title)
    haystack_title_folded = _normalize_for_match(strip_diacritics(document.title))
    query_phrase_accented = _normalize_for_match(normalized.accented_normalized)
    query_phrase_folded = _normalize_for_match(normalized.accent_folded)
    exact_title_phrase = bool(query_phrase_accented) and (
        (query_phrase_accented in haystack_title_accented) or (query_phrase_folded in haystack_title_folded)
    )

    return ExactSignals(
        exact_sku=exact_sku,
        normalized_sku=normalized_sku,
        exact_model=exact_model,
        exact_brand_model=exact_brand_model,
        exact_title_phrase=exact_title_phrase,
        exact_brand=exact_brand,
    )


def rank_tier(signals: ExactSignals) -> RankTier:
    """Map a document's exact signals onto its structural rank tier."""

    if signals.exact_sku or signals.normalized_sku:
        return RankTier.TIER_0_EXACT_SKU
    if signals.exact_brand_model:
        return RankTier.TIER_1_EXACT_BRAND_MODEL
    if signals.exact_title_phrase:
        return RankTier.TIER_2_EXACT_TITLE_PHRASE
    if signals.exact_brand:
        return RankTier.TIER_3_EXACT_BRAND
    return RankTier.TIER_4_RELEVANCE
