/**
 * Deterministic zero-result recovery sequence -- TypeScript counterpart
 * to backend/search_intelligence/zero_result_recovery.py, wired directly
 * into the real R0.1 serving path (native-search-intelligence.ts) rather
 * than staying reference-only.
 *
 * Stage order (stop as soon as one stage returns >= minSufficient
 * candidates):
 *   1. ORIGINAL_ACCENTED_LEXICAL -- exactly what the user typed, lexical.
 *   2. ACCENT_FOLDED_LEXICAL -- token-group / accent-tolerant retrieval.
 *   3. BOUNDED_FUZZY_CORRECTION -- small, bounded typo-tolerant retrieval.
 *   4. REVIEWED_SYNONYMS -- the existing, human-curated production
 *      synonym table (native-synonyms.ts) -- not an LLM/ad-hoc expansion.
 *   5. FUTURE_SEMANTIC_CHANNEL -- absent in R0.1 (no semantic model).
 *
 * Every stage function receives the same never-mutated query string --
 * this module never rewrites the caller's original query; it only
 * sequences calls and records which stage actually produced results.
 */

export enum RecoveryStage {
  ORIGINAL_ACCENTED_LEXICAL = 'ORIGINAL_ACCENTED_LEXICAL',
  ACCENT_FOLDED_LEXICAL = 'ACCENT_FOLDED_LEXICAL',
  BOUNDED_FUZZY_CORRECTION = 'BOUNDED_FUZZY_CORRECTION',
  REVIEWED_SYNONYMS = 'REVIEWED_SYNONYMS',
  FUTURE_SEMANTIC_CHANNEL = 'FUTURE_SEMANTIC_CHANNEL',
  EXHAUSTED = 'EXHAUSTED',
}

export type RecoveryFn<T> = () => Promise<T[]> | T[];

export interface RecoveryResult<T> {
  recoveryStageUsed: RecoveryStage;
  candidates: T[];
  attemptedStages: RecoveryStage[];
}

export async function recoverZeroResult<T>(
  stages: Partial<Record<Exclude<RecoveryStage, RecoveryStage.EXHAUSTED>, RecoveryFn<T>>>,
  minSufficient = 1,
): Promise<RecoveryResult<T>> {
  const order: RecoveryStage[] = [
    RecoveryStage.ORIGINAL_ACCENTED_LEXICAL,
    RecoveryStage.ACCENT_FOLDED_LEXICAL,
    RecoveryStage.BOUNDED_FUZZY_CORRECTION,
    RecoveryStage.REVIEWED_SYNONYMS,
    RecoveryStage.FUTURE_SEMANTIC_CHANNEL,
  ];

  const attempted: RecoveryStage[] = [];
  for (const stage of order) {
    const fn = stages[stage as Exclude<RecoveryStage, RecoveryStage.EXHAUSTED>];
    if (!fn) continue;
    attempted.push(stage);
    let candidates: T[];
    try {
      candidates = await fn();
    } catch (error) {
      // A stage's own candidate pool can overflow its safe cap (see
      // CANDIDATE_POOL_SAFE_CAP in native-search-intelligence.ts) -- common
      // Vietnamese short syllables ("thi", "cong", "tho"...) are substrings
      // of many unrelated words, so ACCENT_FOLDED_LEXICAL and later stages
      // can match hundreds of rows for an ordinary natural-language query.
      // That must never be ranked (the original safety invariant), but it
      // must also not abort recovery outright -- doing so silently killed
      // the semantic channel that runs after EXHAUSTED for every query
      // whose only oversized stage happened to sit mid-pipeline. Treat the
      // stage as if it had found nothing usable and let the sequence
      // continue; a genuine (non-fallback) error still propagates.
      const fallbackReason = error instanceof Error && 'reason' in error
        ? (error as Error & { reason?: unknown }).reason
        : undefined;
      if (
        error instanceof Error
        && error.name === 'IntelligenceFallbackError'
        && fallbackReason === 'CANDIDATE_POOL_TOO_LARGE_FALLBACK'
      ) {
        continue;
      }
      throw error;
    }
    if (candidates.length >= minSufficient) {
      return { recoveryStageUsed: stage, candidates, attemptedStages: attempted };
    }
  }
  return { recoveryStageUsed: RecoveryStage.EXHAUSTED, candidates: [], attemptedStages: attempted };
}
