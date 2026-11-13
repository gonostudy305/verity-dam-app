"""Canonical Vietnamese query normalization.

Vietnamese text can arrive either NFC (precomposed, e.g. a single codepoint
for ``á``) or NFD (decomposed, base letter + combining accent codepoint) --
browsers, mobile IMEs, copy/paste from different sources, and different OS
input methods are all observed to produce either form for the exact same
visible text. Every function here normalizes to NFC first so downstream
comparisons are never fooled by codepoint-level differences that look
identical to a human.

The original, accented query is NEVER discarded. Accent folding
(``accent_folded``) is a search-matching normalization only -- it produces a
comparable ASCII-ish form for fuzzy/typo matching, it is not a semantic
transformation, and both the accented and folded forms remain available on
every :class:`NormalizedQuery` this module returns.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# Vietnamese 'đ'/'Đ' do not decompose under NFD (they are their own letters,
# not base+combining-mark sequences) so they need an explicit fold mapping.
_DJ_FOLD = str.maketrans({"đ": "d", "Đ": "D"})

_WHITESPACE_RE = re.compile(r"\s+")
# Unicode "word" characters: letters/digits/underscore-ish, keeps Vietnamese
# diacritics intact (Python's \w is Unicode-aware by default with re.UNICODE
# implied for str patterns). Internal hyphens are kept as part of a token
# (e.g. "hr-21", "tp-link") since many real SKU codes and brand names in
# this catalog are hyphenated -- splitting on '-' would silently destroy
# the exact token an SKU/brand lookup needs to match against.
_TOKEN_RE = re.compile(r"[^\W_]+(?:-[^\W_]+)*", re.UNICODE)


@dataclass(frozen=True)
class NormalizedQuery:
    """Every normalization stage of one query, none of them destructive.

    ``tokens`` is the whitespace/punctuation-tokenized form of
    ``accented_normalized`` (accents preserved); ``folded_tokens`` is the
    same tokenization applied to ``accent_folded``. Both are exposed because
    downstream matching sometimes wants accent-preserving tokens (e.g. an
    exact vocabulary hit) and sometimes wants folded tokens (e.g. typo
    matching).
    """

    raw_query: str
    unicode_nfc: str
    lowercase_form: str
    normalized_whitespace: str
    accented_normalized: str
    accent_folded: str
    tokens: tuple[str, ...] = field(default_factory=tuple)
    folded_tokens: tuple[str, ...] = field(default_factory=tuple)


def strip_diacritics(text: str) -> str:
    """Fold Vietnamese (and any other combining-mark) diacritics away.

    Uses NFD decomposition + removal of Unicode category ``Mn`` (nonspacing
    combining marks), plus the explicit đ/Đ -> d/D mapping NFD cannot
    express. Case is preserved by this function -- callers that also want a
    case-insensitive comparable form should additionally ``.lower()``/
    ``.casefold()`` the result.
    """

    pre = text.translate(_DJ_FOLD)
    decomposed = unicodedata.normalize("NFD", pre)
    without_marks = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    return unicodedata.normalize("NFC", without_marks)


def tokenize(text: str) -> tuple[str, ...]:
    """Unicode-aware word tokenization; punctuation-only input yields ``()``."""

    return tuple(_TOKEN_RE.findall(text))


def token_spans(text: str) -> tuple[tuple[int, int], ...]:
    """Character ``(start, end)`` spans for each token :func:`tokenize` would
    return from ``text``, in the same order. Used by the entity extractor to
    map a multi-token exact-SKU match back onto the specific token indexes it
    covers (see ``entity_extractor.protected_token_indexes``)."""

    return tuple((match.start(), match.end()) for match in _TOKEN_RE.finditer(text))


def normalize_query(raw_query: str | None) -> NormalizedQuery:
    """Build the full, non-destructive normalization pipeline for one query.

    Pipeline (each stage strictly derived from the previous one, ``raw_query``
    is always preserved verbatim):

    1. ``unicode_nfc``       -- NFC-compose ``raw_query`` (fixes NFD input).
    2. ``lowercase_form``    -- ``unicode_nfc.lower()``.
    3. ``normalized_whitespace`` -- collapse runs of whitespace to a single
       space and strip leading/trailing whitespace, on ``lowercase_form``.
    4. ``accented_normalized`` -- identical to ``normalized_whitespace``;
       kept as its own named field (rather than folded into step 3) because
       it is the semantically meaningful stage for callers: the canonical,
       accent-preserving, punctuation-preserving comparable form of the
       query (hyphens inside SKU codes/brand names like "HR-21" or
       "TP-Link" are deliberately NOT stripped here -- only whitespace is
       normalized; word-level tokenization is a separate, explicit stage
       below, not something this field silently performs).
    5. ``accent_folded``     -- diacritics stripped from
       ``accented_normalized`` via :func:`strip_diacritics`.
    6. ``tokens``/``folded_tokens`` -- the explicit word-level tokenization
       of ``accented_normalized``/``accent_folded`` (punctuation dropped
       here, not upstream).
    """

    raw = raw_query if isinstance(raw_query, str) else ""
    nfc = unicodedata.normalize("NFC", raw)
    lowercase_form = nfc.lower()
    normalized_whitespace = _WHITESPACE_RE.sub(" ", lowercase_form).strip()
    accented_normalized = normalized_whitespace
    accent_folded = strip_diacritics(accented_normalized)
    tokens = tokenize(accented_normalized)
    folded_tokens = tuple(strip_diacritics(token) for token in tokens)
    return NormalizedQuery(
        raw_query=raw,
        unicode_nfc=nfc,
        lowercase_form=lowercase_form,
        normalized_whitespace=normalized_whitespace,
        accented_normalized=accented_normalized,
        accent_folded=accent_folded,
        tokens=tokens,
        folded_tokens=folded_tokens,
    )
