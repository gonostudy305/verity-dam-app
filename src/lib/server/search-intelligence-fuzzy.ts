/**
 * Bounded, corpus-driven fuzzy/typo correction for the TypeScript R0.1
 * serving runtime.
 *
 * SCOPING NOTE (see the mission's judgment-calls disclosure): this is
 * NOT a line-for-line port of backend/search_intelligence/typo_model.py's
 * frozen-vocabulary + weighted-edit-cost model. Rather than requiring the
 * Next.js API route to load/maintain the Python reference's full
 * vocabulary file, this module corrects a query token against a small,
 * static, catalog-relevant vocabulary of brand/category/feature words
 * using plain Levenshtein edit distance, bounded at every step:
 *
 *   1. Only tokens of length >= 3 are ever corrected (short tokens are
 *      too ambiguous to safely correct).
 *   2. Only vocabulary words within MAX_EDIT_DISTANCE are considered.
 *   3. At most MAX_CANDIDATES_PER_TOKEN corrections are kept per token.
 *   4. At most MAX_TOTAL_CANDIDATES corrected tokens are used to build
 *      the bounded ILIKE-ANY retrieval stage (native-search-intelligence.ts).
 *
 * This gives genuine, bounded typo tolerance ("acmee" -> "acme",
 * "robork" -> "robot", "driit" -> "drift") without any unbounded
 * combinatorial expansion, and without requiring Python's vocabulary file
 * to be duplicated/maintained in two languages. Full byte-identical
 * fuzzy-correction parity with the Python reference is explicitly NOT
 * claimed (see the module notes above;
 * ) -- only normalization/tokenization/exact-tier parity is.
 */

export const MAX_EDIT_DISTANCE = 2;
export const MAX_CANDIDATES_PER_TOKEN = 3;
export const MAX_TOTAL_CANDIDATES = 20;

// A small, catalog-relevant static vocabulary -- brand names and common
// Vietnamese homeware category/feature/space words that appear across
// this catalog's real titles/brands/categories. Kept intentionally short
// and reviewable; extending it is a safe, low-risk future change (never
// requires a DB migration or model activation).
export const STATIC_VOCABULARY: readonly string[] = [
  // brands
  'acme', 'verity', 'dalia', 'eden', 'nova', 'drift', 'imex', 'hikon', 'ecolo', 'tp-link', 'yale',
  // category / product words
  'khóa', 'camera', 'robot', 'chuông', 'rèm', 'đèn', 'công', 'tắc', 'cắm',
  // action / feature words
  'hút', 'bụi', 'cảm', 'biến', 'chuyển', 'động', 'thông', 'minh', 'zigbee', 'homekit', 'wifi',
  // space / install-context words
  'phòng', 'khách', 'ngủ', 'cửa', 'chính', 'ngoài', 'trời', 'bếp', 'sân', 'vườn',
  // english model/descriptor words seen in canary queries
  'dream', 'ultra', 'pro',
];

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i][0] = i;
  for (let j = 0; j < cols; j += 1) distances[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(
        distances[i - 1][j] + 1,
        distances[i][j - 1] + 1,
        distances[i - 1][j - 1] + cost,
      );
    }
  }
  return distances[rows - 1][cols - 1];
}

export interface TokenCorrection {
  originalToken: string;
  correctedToken: string;
  editDistance: number;
}

/** Correct one token against the static vocabulary; bounded per-token. */
export function correctToken(
  token: string,
  vocabulary: readonly string[] = STATIC_VOCABULARY,
): TokenCorrection[] {
  if (token.length < 3) return [];
  const candidates: TokenCorrection[] = [];
  for (const word of vocabulary) {
    if (word === token) return []; // already an exact vocabulary word -- nothing to correct
    const distance = levenshteinDistance(token, word);
    if (distance > 0 && distance <= MAX_EDIT_DISTANCE) {
      candidates.push({ originalToken: token, correctedToken: word, editDistance: distance });
    }
  }
  candidates.sort((a, b) => (a.editDistance !== b.editDistance ? a.editDistance - b.editDistance : a.correctedToken < b.correctedToken ? -1 : 1));
  return candidates.slice(0, MAX_CANDIDATES_PER_TOKEN);
}

/** Bounded fuzzy-correction over every token in a query; returns a
 * deduplicated, capped list of corrected tokens usable directly as ILIKE
 * pattern sources -- never an unbounded/combinatorial expansion. */
export function correctQueryTokens(tokens: readonly string[], vocabulary: readonly string[] = STATIC_VOCABULARY): TokenCorrection[] {
  const pooled: TokenCorrection[] = [];
  for (const token of tokens) {
    pooled.push(...correctToken(token, vocabulary));
  }
  pooled.sort((a, b) => (a.editDistance !== b.editDistance ? a.editDistance - b.editDistance : a.correctedToken < b.correctedToken ? -1 : 1));
  const seen = new Set<string>();
  const deduped: TokenCorrection[] = [];
  for (const candidate of pooled) {
    if (seen.has(candidate.correctedToken)) continue;
    seen.add(candidate.correctedToken);
    deduped.push(candidate);
    if (deduped.length >= MAX_TOTAL_CANDIDATES) break;
  }
  return deduped;
}
