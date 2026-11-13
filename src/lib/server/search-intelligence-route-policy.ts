/**
 * Item 12 (sort compatibility policy), extracted as a pure, directly
 * testable function so `src/app/api/media/route.ts` and its tests share
 * ONE source of truth instead of duplicating this logic.
 *
 * Explicit policy:
 *  - empty query               -> BASELINE_L0 (nothing for intelligence to rank)
 *  - flag disabled             -> BASELINE_L0 (Item 13: zero extra queries)
 *  - explicit sort=most_used   -> BASELINE_L0 (usage-count ordering has no
 *                                  well-defined relevance-ranking meaning)
 *  - explicit sort=unused      -> BASELINE_L0 (same reasoning)
 *  - include_deleted / deleted_only admin views -> BASELINE_L0 (those are
 *    moderation views, not end-user search; keeping them on the simple,
 *    battle-tested baseline path is the conservative choice)
 *  - default case: sort=newest AND a non-empty query -> intelligence path
 *    is ELIGIBLE (still gated by the flag; the gateway falls back to
 *    baseline on any intelligence-path error regardless).
 */

import type { MediaListParams } from '@/lib/media-api';

export interface IntelligenceEligibilityInput {
  flagEnabled: boolean;
  query: string;
  sort: MediaListParams['sort'];
  includeDeleted: boolean;
  deletedOnly: boolean;
}

export function isIntelligenceEligible(input: IntelligenceEligibilityInput): boolean {
  return (
    input.flagEnabled &&
    input.query.length > 0 &&
    input.sort === 'newest' &&
    !input.includeDeleted &&
    !input.deletedOnly
  );
}
