import type { DedupTier } from '@/types/dedup';
import { TIER_COPY } from './tier-copy';

export function DuplicateTierBadge({ tier }: { tier: DedupTier }) {
  const copy = TIER_COPY[tier];
  return <span title={copy.description} className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold ${copy.className}`}>{copy.label}</span>;
}
