"""Field-weighted, explainable lexical scorer.

Every score this module produces exposes its full component breakdown
(e.g. ``{"title_exact_phrase": 3.0, "title_token_coverage": 0.9, ...}``) so
nothing is a black-box number. ``CANDIDATE_WEIGHTS_ONLY`` is explicitly
NOT production truth -- these are placeholder weights for this offline
engine to be exercised/tested against; real weight tuning is future work
(Suite C human labels + the future LTR checkpoint), never invented here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .search_document import SearchDocument
from .vietnamese_normalizer import NormalizedQuery, strip_diacritics, tokenize

# Fields the current production ILIKE path already searches (see
# docs/search/VIETNAMESE_SEARCH_ARCHITECTURE.md, listWhere()) -- this
# scorer adds no new field, only an explainable weighting on top of them.
_SCORED_FIELDS: tuple[str, ...] = ("sku", "title", "brand", "category", "space", "keywords", "caption")

# CANDIDATE_WEIGHTS_ONLY -- placeholder, tunable weights. Not production
# truth. SKU/title carry the most weight since they are the fields a user
# most often searches by; keywords/caption (auto-generated Vision output)
# carry the least, reflecting that they are the least curated fields.
CANDIDATE_WEIGHTS_ONLY: dict[str, float] = {
    "sku_exact_phrase": 5.0,
    "sku_token_coverage": 3.0,
    "sku_prefix_match": 2.0,
    "title_exact_phrase": 3.0,
    "title_all_token_match": 2.0,
    "title_token_coverage": 1.5,
    "title_prefix_match": 1.0,
    "brand_exact_phrase": 2.5,
    "brand_token_coverage": 1.0,
    "brand_prefix_match": 0.5,
    "category_exact_phrase": 2.0,
    "category_token_coverage": 1.0,
    "category_prefix_match": 0.5,
    "space_exact_phrase": 1.5,
    "space_token_coverage": 0.75,
    "space_prefix_match": 0.25,
    "keywords_token_coverage": 1.0,
    "keywords_exact_phrase": 1.5,
    "caption_token_coverage": 0.5,
    "caption_exact_phrase": 0.75,
}

# Small per-field bonus for having matched via the accented form rather
# than only the accent-folded form -- an accented hit is a stronger signal
# that the query text and the field text genuinely agree, not just after
# stripping diacritics. Applied once per field that has ANY match.
ACCENTED_MATCH_BONUS = 0.1
ACCENT_FOLDED_MATCH_BONUS = 0.0  # explicit placeholder: folded-only matches get no extra bonus beyond the base feature weights


def _norm(text: str) -> str:
    return " ".join(text.split()).casefold()


@dataclass(frozen=True)
class FieldFeatures:
    exact_phrase: bool
    all_token_match: bool
    token_coverage: float
    prefix_match: bool
    accented_match: bool
    accent_folded_match: bool


def _field_features(field_text: str, normalized: NormalizedQuery) -> FieldFeatures:
    field_accented = _norm(field_text)
    field_folded = _norm(strip_diacritics(field_text))
    query_accented = _norm(normalized.accented_normalized)
    query_folded = _norm(normalized.accent_folded)

    if not field_accented or not query_accented:
        return FieldFeatures(False, False, 0.0, False, False, False)

    exact_phrase_accented = query_accented in field_accented
    exact_phrase_folded = query_folded in field_folded
    exact_phrase = exact_phrase_accented or exact_phrase_folded

    field_tokens_folded = set(tokenize(field_folded))
    query_tokens = normalized.folded_tokens
    if query_tokens:
        matched = sum(1 for token in query_tokens if token in field_tokens_folded)
        token_coverage = matched / len(query_tokens)
        all_token_match = matched == len(query_tokens)
    else:
        token_coverage = 0.0
        all_token_match = False

    prefix_match = field_accented.startswith(query_accented) or field_folded.startswith(query_folded)

    return FieldFeatures(
        exact_phrase=exact_phrase,
        all_token_match=all_token_match,
        token_coverage=token_coverage,
        prefix_match=prefix_match,
        accented_match=exact_phrase_accented,
        accent_folded_match=exact_phrase_folded and not exact_phrase_accented,
    )


def _field_text(document: SearchDocument, field_name: str) -> str:
    if field_name == "keywords":
        return " ".join(document.keywords)
    if field_name == "caption":
        return document.suggested_caption
    return getattr(document, field_name, "")


@dataclass(frozen=True)
class LexicalScore:
    """A document's full lexical score against one query, plus every
    component that fed it -- never a single opaque float."""

    total: float
    breakdown: dict[str, float] = field(default_factory=dict)


def score_document(document: SearchDocument, normalized: NormalizedQuery) -> LexicalScore:
    """Pure function: no DB, no side effects, deterministic given the same
    (document, normalized query)."""

    breakdown: dict[str, float] = {}
    total = 0.0
    for field_name in _SCORED_FIELDS:
        text = _field_text(document, field_name)
        if not text:
            continue
        features = _field_features(text, normalized)
        if features.exact_phrase:
            weight = CANDIDATE_WEIGHTS_ONLY.get(f"{field_name}_exact_phrase", 0.0)
            if weight:
                breakdown[f"{field_name}_exact_phrase"] = weight
                total += weight
        if features.all_token_match and f"{field_name}_all_token_match" in CANDIDATE_WEIGHTS_ONLY:
            weight = CANDIDATE_WEIGHTS_ONLY[f"{field_name}_all_token_match"]
            breakdown[f"{field_name}_all_token_match"] = weight
            total += weight
        if features.token_coverage > 0:
            weight = CANDIDATE_WEIGHTS_ONLY.get(f"{field_name}_token_coverage", 0.0) * features.token_coverage
            if weight:
                breakdown[f"{field_name}_token_coverage"] = round(weight, 6)
                total += weight
        if features.prefix_match:
            weight = CANDIDATE_WEIGHTS_ONLY.get(f"{field_name}_prefix_match", 0.0)
            if weight:
                breakdown[f"{field_name}_prefix_match"] = weight
                total += weight
        if features.accented_match:
            breakdown[f"{field_name}_accented_bonus"] = ACCENTED_MATCH_BONUS
            total += ACCENTED_MATCH_BONUS

    return LexicalScore(total=round(total, 6), breakdown=breakdown)
