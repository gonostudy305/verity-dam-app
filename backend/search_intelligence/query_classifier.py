"""Deterministic, rule-based query-type classification.

:class:`QueryClassifier` is a ``Protocol`` so a future ML classifier can be
swapped in behind the exact same interface (``classify(normalized,
entities) -> QueryClassification``) without changing any caller. No ML
classifier is built or trained in this checkpoint, and no training labels
are fabricated for one -- see the package docstring for the hard ML
boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol

from .entity_extractor import EntityExtractionResult
from .vietnamese_normalizer import NormalizedQuery

# A tiny, curated set of ASCII function/adjective words that recur in this
# repo's own real product titles and UI copy (e.g. "thông minh" = smart,
# "cho" = for) -- used only to distinguish natural-language phrasing from a
# bare keyword query. Not a general-purpose language model, and not used
# for translation -- purely a heuristic signal.
_VIETNAMESE_NL_MARKERS: tuple[str, ...] = ("cho", "nào", "gì", "loại", "nhất", "hơn", "voi", "với")


class QueryType(str, Enum):
    EXACT_SKU = "EXACT_SKU"
    BRAND_PRODUCT = "BRAND_PRODUCT"
    PRODUCT_CATEGORY = "PRODUCT_CATEGORY"
    ATTRIBUTE_FEATURE = "ATTRIBUTE_FEATURE"
    SCENE_USE_CASE = "SCENE_USE_CASE"
    NATURAL_LANGUAGE = "NATURAL_LANGUAGE"
    MIXED_VI_EN = "MIXED_VI_EN"
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True)
class QueryClassification:
    query_type: QueryType
    confidence: float
    signals: tuple[str, ...] = field(default_factory=tuple)


class QueryClassifier(Protocol):
    """Interface a future ML classifier can implement in place of the rule-based one."""

    def classify(self, normalized: NormalizedQuery, entities: EntityExtractionResult) -> QueryClassification: ...


def _has_accented_vietnamese(normalized: NormalizedQuery) -> bool:
    return normalized.accented_normalized != normalized.accent_folded


def _has_ascii_alpha_token(normalized: NormalizedQuery) -> bool:
    return any(token.isascii() and token.isalpha() and len(token) >= 2 for token in normalized.tokens)


class RuleBasedQueryClassifier:
    """Deterministic classification in a fixed, documented precedence order.

    1. Any exact SKU entity match -> ``EXACT_SKU`` (highest-precision signal
       available; a real SKU code was found). This always outranks every
       other signal, including a space/scene signal.
    2. A brand entity plus (a category OR at least 2 tokens, i.e. "brand +
       something else") -> ``BRAND_PRODUCT``.
    3. A space or installation-context entity (alone, or combined with a
       category/feature) -> ``SCENE_USE_CASE``. This is checked BEFORE
       ``PRODUCT_CATEGORY``/``ATTRIBUTE_FEATURE`` so a query like "robot hút
       bụi phòng khách" (category + space) or "khóa cửa chính" (category +
       space) correctly reports the scene/use-case intent rather than being
       swallowed by the plain category branch -- the architecture contract
       is that a space/installation-context signal, once present, dominates
       a bare category/feature signal (but never an exact SKU).
    4. A category entity with no brand and no space/installation-context
       signal -> ``PRODUCT_CATEGORY``.
    5. A feature/protocol entity with no category/brand/space signal ->
       ``ATTRIBUTE_FEATURE``.
    6. Query has both an accented Vietnamese token and a plain-ASCII
       alphabetic token that is not itself a recognized Vietnamese
       diacritic-bearing word (i.e. genuine code-switching, not just an
       accent-folded Vietnamese word) and no stronger entity signal fired
       -> ``MIXED_VI_EN``.
    7. 4+ tokens with no entity signal and no mixed-language signal,
       optionally containing a natural-language marker word -> ``NATURAL_LANGUAGE``.
    8. Empty query, or nothing else matched -> ``UNKNOWN``.
    """

    def classify(self, normalized: NormalizedQuery, entities: EntityExtractionResult) -> QueryClassification:
        if not normalized.tokens:
            return QueryClassification(QueryType.UNKNOWN, confidence=1.0, signals=("empty_query",))

        if entities.skus:
            return QueryClassification(
                QueryType.EXACT_SKU,
                confidence=1.0,
                signals=tuple(f"sku:{match.record.sku}" for match in entities.skus),
            )

        if entities.brands and (entities.categories or len(normalized.tokens) >= 2):
            return QueryClassification(
                QueryType.BRAND_PRODUCT,
                confidence=0.9 if entities.categories else 0.75,
                signals=tuple(f"brand:{match.value}" for match in entities.brands)
                + tuple(f"category:{match.value}" for match in entities.categories),
            )

        if entities.spaces or entities.installation_contexts:
            return QueryClassification(
                QueryType.SCENE_USE_CASE,
                confidence=0.85 if entities.categories or entities.features else 0.8,
                signals=tuple(f"space:{match.value}" for match in entities.spaces)
                + tuple(f"install_context:{match.value}" for match in entities.installation_contexts)
                + tuple(f"category:{match.value}" for match in entities.categories)
                + tuple(f"feature:{match.value}" for match in entities.features),
            )

        if entities.categories and not entities.brands:
            return QueryClassification(
                QueryType.PRODUCT_CATEGORY,
                confidence=0.85,
                signals=tuple(f"category:{match.value}" for match in entities.categories),
            )

        if (entities.features or entities.protocols) and not entities.categories and not entities.brands:
            return QueryClassification(
                QueryType.ATTRIBUTE_FEATURE,
                confidence=0.8,
                signals=tuple(f"feature:{match.value}" for match in entities.features)
                + tuple(f"protocol:{match.value}" for match in entities.protocols),
            )

        has_accented = _has_accented_vietnamese(normalized)
        has_ascii_word = _has_ascii_alpha_token(normalized)
        if has_accented and has_ascii_word:
            return QueryClassification(
                QueryType.MIXED_VI_EN,
                confidence=0.6,
                signals=("has_accented_vietnamese_token", "has_ascii_alpha_token"),
            )

        if len(normalized.tokens) >= 4:
            markers = tuple(marker for marker in _VIETNAMESE_NL_MARKERS if marker in normalized.folded_tokens)
            return QueryClassification(
                QueryType.NATURAL_LANGUAGE,
                confidence=0.65 if markers else 0.5,
                signals=("token_count>=4",) + tuple(f"nl_marker:{marker}" for marker in markers),
            )

        return QueryClassification(QueryType.UNKNOWN, confidence=0.3, signals=("no_signal_matched",))
