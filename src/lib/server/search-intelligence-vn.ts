/**
 * Canonical Vietnamese query normalization -- the TypeScript R0.1 serving
 * runtime's counterpart to backend/search_intelligence/vietnamese_normalizer.py.
 *
 * This is NOT a byte-for-byte port of the Python file (different
 * language, different regex engine) but is designed to produce
 * IDENTICAL output for the same input on every field a caller relies on
 * for ranking: NFC normalization, lowercasing, whitespace collapsing,
 * đ/Đ + combining-mark accent folding, and Unicode-aware word
 * tokenization (internal hyphens kept, matching real SKU/brand codes
 * like "HR-21"/"tp-link").  See
 * search-intelligence-vn.test.ts for the proof.
 *
 * The original, accented query is NEVER discarded -- accent folding is a
 * search-matching normalization only, never a semantic transformation.
 */

const WHITESPACE_RE = /\s+/g;
// Unicode letters/digits, keeping internal hyphens as part of one token
// (mirrors Python's `[^\W_]+(?:-[^\W_]+)*` under re.UNICODE).
const TOKEN_RE = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
// Combining Diacritical Marks block (U+0300-U+036F) -- covers every
// Vietnamese tone/accent combining mark after NFD decomposition, same
// range already used by createStorageFileName() in media-api.ts.
const COMBINING_MARK_RE = /[\u0300-\u036f]/g;

export interface NormalizedQuery {
  rawQuery: string;
  unicodeNfc: string;
  lowercaseForm: string;
  normalizedWhitespace: string;
  accentedNormalized: string;
  accentFolded: string;
  tokens: readonly string[];
  foldedTokens: readonly string[];
}

/**
 * Fold Vietnamese (and any other combining-mark) diacritics away.
 * 'đ'/'Đ' do not decompose under NFD (they are their own letters, not
 * base+combining-mark sequences) so they need an explicit mapping first,
 * exactly like the Python reference's `_DJ_FOLD`.
 */
export function stripDiacritics(text: string): string {
  const withoutDj = text.replace(/đ/g, 'd').replace(/Đ/g, 'D');
  const decomposed = withoutDj.normalize('NFD');
  const withoutMarks = decomposed.replace(COMBINING_MARK_RE, '');
  return withoutMarks.normalize('NFC');
}

/** Unicode-aware word tokenization; punctuation-only input yields []. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

export function normalizeQuery(rawQuery: string | null | undefined): NormalizedQuery {
  const raw = typeof rawQuery === 'string' ? rawQuery : '';
  const unicodeNfc = raw.normalize('NFC');
  const lowercaseForm = unicodeNfc.toLowerCase();
  const normalizedWhitespace = lowercaseForm.replace(WHITESPACE_RE, ' ').trim();
  const accentedNormalized = normalizedWhitespace;
  const accentFolded = stripDiacritics(accentedNormalized);
  const tokens = tokenize(accentedNormalized);
  const foldedTokens = tokens.map((token) => stripDiacritics(token));

  return {
    rawQuery: raw,
    unicodeNfc,
    lowercaseForm,
    normalizedWhitespace,
    accentedNormalized,
    accentFolded,
    tokens,
    foldedTokens,
  };
}

/** Case-fold + whitespace-collapse comparison form (mirrors Python's
 * `_normalize_for_match`) -- punctuation is deliberately preserved. */
export function normalizeForMatch(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

/**
 * Does `needle` appear as a COMPLETE, boundary-respecting span inside
 * `haystack`? Both are assumed already normalized via normalizeForMatch.
 * Punctuation is compared literally, never stripped. A match only counts
 * if the character immediately before and after the match (if any) is
 * NOT alphanumeric -- this is what makes "ABC-123" match inside "acme
 * ABC-123" while correctly rejecting it as a match inside "ABC-1234".
 */
export function boundedExactSpanMatch(needle: string, haystack: string): boolean {
  if (!needle) return false;
  const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  let start = 0;
  for (;;) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) return false;
    const end = index + needle.length;
    const beforeOk = index === 0 || !isAlnum(haystack[index - 1]);
    const afterOk = end === haystack.length || !isAlnum(haystack[end]);
    if (beforeOk && afterOk) return true;
    start = index + 1;
  }
}

/** Escape a raw term for safe use inside a parameterized ILIKE '%...%'
 * pattern -- escapes backslash/%/_ , mirroring native-media.ts's existing
 * escaping so both search paths behave identically against the same
 * literal input. Never used to build a concatenated SQL string -- the
 * escaped pattern is always passed as a bound parameter value. */
export function escapeIlikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
