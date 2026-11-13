"""Vietnamese-tuned typo/fuzzy candidate generation.

A weighted edit-cost model (Optimal String Alignment -- Levenshtein plus
adjacent transpositions) with substitution costs tuned for the failure
modes Vietnamese input actually produces:

  * missing accent / wrong accent / missing tone mark -- "khoa" vs "khóa",
    "biên" vs "biến": same base letter, different (or absent) diacritic.
    Detected by folding both characters and checking equality.
  * near-key keyboard errors -- adjacent QWERTY keys substituted.
  * character deletion/insertion/transposition -- generic edit operations,
    plus an explicit adjacent-transposition rule (accent-difference-aware,
    so "thôgn" -> "thông" and "aqraa" -> "acme" both cost roughly the
    same low amount a human would expect).
  * Telex-like residue -- a trailing tone-key letter (s/f/r/x/j) left over
    from an input method that didn't compose the diacritic.
  * VNI-like residue -- a trailing tone/mark digit (1-9) left over the
    same way.

This module NEVER corrects a token that :func:`is_known_sku_token`
recognizes as an exact SKU -- see the guard in
:func:`generate_token_candidates`. Default behaviour throughout this
checkpoint is to search BOTH the original query and any correction
candidates; nothing here silently replaces a low-confidence original.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .entity_extractor import is_known_sku_token, protected_token_indexes
from .vietnamese_normalizer import NormalizedQuery, strip_diacritics
from .vocabulary import TOKEN_VOCABULARY

# --- tuned cost constants -----------------------------------------------
ACCENT_SUB_COST = 0.3
KEYBOARD_SUB_COST = 0.6
GENERIC_SUB_COST = 1.0
INSERT_DELETE_COST = 1.0
TRANSPOSITION_COST = 0.5
TELEX_RESIDUE_COST = 0.25
VNI_RESIDUE_COST = 0.25
DEFAULT_MAX_NORMALIZED_COST = 0.45
DEFAULT_MAX_CANDIDATES_PER_TOKEN = 5

# Telex leftover tone-key letters: s=sắc, f=huyền, r=hỏi, x=ngã, j=nặng.
TELEX_RESIDUE_CHARS = frozenset("sfjrx")
# VNI leftover tone/mark digits: 1=sắc,2=huyền,3=hỏi,4=ngã,5=nặng,
# 6/7/8/9=circumflex/horn/breve modifiers.
VNI_RESIDUE_DIGITS = frozenset("123456789")


def _build_keyboard_adjacency() -> frozenset[frozenset[str]]:
    rows = ("qwertyuiop", "asdfghjkl", "zxcvbnm")
    pairs: set[frozenset[str]] = set()
    for row in rows:
        for left, right in zip(row, row[1:]):
            pairs.add(frozenset((left, right)))
    return frozenset(pairs)


KEYBOARD_ADJACENT_PAIRS: frozenset[frozenset[str]] = _build_keyboard_adjacency()


def _fold_char(ch: str) -> str:
    return strip_diacritics(ch).casefold()


def _char_sub_cost(x: str, y: str) -> float:
    if x == y:
        return 0.0
    if _fold_char(x) == _fold_char(y):
        return ACCENT_SUB_COST
    if frozenset((_fold_char(x), _fold_char(y))) in KEYBOARD_ADJACENT_PAIRS:
        return KEYBOARD_SUB_COST
    return GENERIC_SUB_COST


def weighted_edit_distance(a: str, b: str) -> float:
    """OSA-style edit distance with accent/keyboard-aware substitution cost
    and an accent-difference-aware adjacent-transposition rule."""

    n, m = len(a), len(b)
    if n == 0:
        return float(m) * INSERT_DELETE_COST
    if m == 0:
        return float(n) * INSERT_DELETE_COST
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * INSERT_DELETE_COST
    for j in range(1, m + 1):
        dp[0][j] = j * INSERT_DELETE_COST
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            sub_cost = _char_sub_cost(a[i - 1], b[j - 1])
            best = min(
                dp[i - 1][j] + INSERT_DELETE_COST,
                dp[i][j - 1] + INSERT_DELETE_COST,
                dp[i - 1][j - 1] + sub_cost,
            )
            if (
                i > 1 and j > 1
                and _fold_char(a[i - 1]) == _fold_char(b[j - 2])
                and _fold_char(a[i - 2]) == _fold_char(b[j - 1])
            ):
                transposition_extra = _char_sub_cost(a[i - 1], b[j - 2]) + _char_sub_cost(a[i - 2], b[j - 1])
                best = min(best, dp[i - 2][j - 2] + TRANSPOSITION_COST + transposition_extra)
            dp[i][j] = best
    return dp[n][m]


def _is_pure_accent_diff(a: str, b: str) -> bool:
    return len(a) == len(b) and a != b and strip_diacritics(a).casefold() == strip_diacritics(b).casefold()


def _is_adjacent_transposition(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    diffs = [index for index in range(len(a)) if a[index] != b[index]]
    if len(diffs) != 2:
        return False
    i, j = diffs
    return j == i + 1 and _fold_char(a[i]) == _fold_char(b[j]) and _fold_char(a[j]) == _fold_char(b[i])


def _is_single_keyboard_substitution(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    diffs = [index for index in range(len(a)) if a[index] != b[index]]
    if len(diffs) != 1:
        return False
    (index,) = diffs
    return frozenset((_fold_char(a[index]), _fold_char(b[index]))) in KEYBOARD_ADJACENT_PAIRS


def _residue_strip(token: str) -> tuple[str, str] | None:
    if len(token) < 3:
        return None
    last = token[-1]
    if last in TELEX_RESIDUE_CHARS:
        return token[:-1], "telex_residue"
    if last in VNI_RESIDUE_DIGITS:
        return token[:-1], "vni_residue"
    return None


@dataclass(frozen=True)
class TypoCandidate:
    """One explainable correction candidate for a single query token."""

    original_token: str
    corrected_token: str
    edit_type: str
    cost: float
    normalized_cost: float
    confidence: float
    vocabulary_source: str


def _classify_and_cost(query_token: str, vocab_token: str) -> tuple[str, float]:
    """Return (edit_type, cost) for the cheapest explainable path found."""

    base_cost = weighted_edit_distance(query_token, vocab_token)
    best_type, best_cost = "generic_edit", base_cost

    residue = _residue_strip(query_token)
    if residue is not None:
        stripped, residue_type = residue
        residue_cost = (TELEX_RESIDUE_COST if residue_type == "telex_residue" else VNI_RESIDUE_COST) + \
            weighted_edit_distance(stripped, vocab_token)
        if residue_cost < best_cost:
            best_type, best_cost = residue_type, residue_cost

    if _is_pure_accent_diff(query_token, vocab_token) and ACCENT_SUB_COST <= best_cost:
        best_type, best_cost = "accent_or_tone", min(best_cost, ACCENT_SUB_COST)
    elif _is_adjacent_transposition(query_token, vocab_token):
        # Cost already reflected via the DP's transposition rule in base_cost;
        # only relabel if the DP-found cost matches this simpler explanation.
        if abs(base_cost - best_cost) < 1e-9 or best_type == "generic_edit":
            best_type = "transposition" if best_type == "generic_edit" else best_type
    elif _is_single_keyboard_substitution(query_token, vocab_token) and best_type == "generic_edit":
        best_type, best_cost = "keyboard_adjacent", min(best_cost, KEYBOARD_SUB_COST)

    return best_type, best_cost


def correct_token(
    token: str,
    *,
    vocabulary: dict[str, str] | None = None,
    max_candidates: int = DEFAULT_MAX_CANDIDATES_PER_TOKEN,
    max_normalized_cost: float = DEFAULT_MAX_NORMALIZED_COST,
) -> tuple[TypoCandidate, ...]:
    """Correction candidates for one token, or ``()`` if none clear the bar.

    Conservative SKU guard: if ``token`` already exactly identifies a real
    SKU (:func:`~search_intelligence.entity_extractor.is_known_sku_token`),
    this returns ``()`` immediately -- SKU tokens are never fuzzy-corrected
    into a different SKU or into an unrelated vocabulary word.
    """

    if is_known_sku_token(token):
        return ()
    if not token:
        return ()

    vocab = vocabulary if vocabulary is not None else TOKEN_VOCABULARY
    token_fold_key = token.casefold()
    if token_fold_key in vocab and vocab[token_fold_key] == token:
        return ()  # already an exact, correctly-spelled vocabulary word.

    candidates: list[TypoCandidate] = []
    for _, vocab_token in vocab.items():
        if vocab_token == token:
            continue
        edit_type, cost = _classify_and_cost(token, vocab_token)
        denom = max(len(token), len(vocab_token), 1)
        normalized_cost = cost / denom
        if normalized_cost > max_normalized_cost:
            continue
        confidence = max(0.0, min(1.0, 1.0 - normalized_cost))
        candidates.append(
            TypoCandidate(
                original_token=token,
                corrected_token=vocab_token,
                edit_type=edit_type,
                cost=cost,
                normalized_cost=normalized_cost,
                confidence=confidence,
                vocabulary_source="search_intelligence.vocabulary.TOKEN_VOCABULARY",
            )
        )

    candidates.sort(key=lambda candidate: (candidate.normalized_cost, candidate.corrected_token))
    # De-duplicate by corrected_token, keeping the lowest-cost explanation.
    deduped: dict[str, TypoCandidate] = {}
    for candidate in candidates:
        if candidate.corrected_token not in deduped:
            deduped[candidate.corrected_token] = candidate
    return tuple(sorted(deduped.values(), key=lambda candidate: (candidate.normalized_cost, candidate.corrected_token))[:max_candidates])


@dataclass(frozen=True)
class QueryCorrectionResult:
    """Per-token correction candidates for a whole normalized query.

    ``search_original`` is always ``True`` -- callers must search the
    original query regardless of whether correction candidates exist; this
    field exists so that invariant is visible/assertable at every call
    site, not just documented in prose.

    ``protected_token_indexes`` lists every token index that fell inside an
    exact, possibly multi-token SKU match (see
    :func:`~search_intelligence.entity_extractor.protected_token_indexes`)
    and was therefore skipped for correction regardless of what the
    single-token SKU guard alone would have allowed -- e.g. for "l20
    ultra" or "DEMO-014", no single token is itself a complete
    SKU code, but every token in that matched span is protected here.
    """

    per_token: tuple[tuple[str, tuple[TypoCandidate, ...]], ...]
    search_original: bool = True
    protected_token_indexes: tuple[int, ...] = field(default_factory=tuple)


def generate_query_candidates(
    normalized: NormalizedQuery,
    *,
    vocabulary: dict[str, str] | None = None,
    max_candidates: int = DEFAULT_MAX_CANDIDATES_PER_TOKEN,
    max_normalized_cost: float = DEFAULT_MAX_NORMALIZED_COST,
) -> QueryCorrectionResult:
    protected = protected_token_indexes(normalized)
    protected_set = set(protected)
    per_token = tuple(
        (
            token,
            ()
            if index in protected_set
            else correct_token(
                token,
                vocabulary=vocabulary,
                max_candidates=max_candidates,
                max_normalized_cost=max_normalized_cost,
            ),
        )
        for index, token in enumerate(normalized.tokens)
    )
    return QueryCorrectionResult(per_token=per_token, protected_token_indexes=protected)
