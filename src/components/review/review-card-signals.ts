import type { ReviewQueueItem } from '@/types/media';

/** Matches ConfidenceMeter's green/amber boundary for overview decisions. */
export const REVIEW_CONFIDENCE_ATTENTION_THRESHOLD = 85;

export interface ReviewCardSignals {
  confidence: number | null;
  hasLowConfidence: boolean;
  hasMissingSku: boolean;
  isInternal: boolean;
  hasPeople: boolean;
  isDuplicate: boolean;
  needsPostProduction: boolean;
}

export interface ReviewSelectionSummary {
  total: number;
  lowConfidence: number;
  missingSku: number;
  duplicates: number;
}

export function normalizeReviewConfidence(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

export function getReviewCardSignals(item: ReviewQueueItem): ReviewCardSignals {
  const confidence = normalizeReviewConfidence(
    item.sku_match?.similarity ?? item.asset.ai_confidence?.sku
  );
  return {
    confidence,
    hasLowConfidence: confidence !== null && confidence < REVIEW_CONFIDENCE_ATTENTION_THRESHOLD,
    hasMissingSku: !item.asset.sku?.trim(),
    isInternal: item.asset.permission === 'internal',
    hasPeople: item.asset.ai_flags?.has_people === true,
    isDuplicate: item.is_duplicate,
    needsPostProduction: Boolean(item.asset.needs_post_production),
  };
}

/** Keep batch-confirm counts and Grid warning badges on one predicate set. */
export function summariseReviewSelection(items: ReviewQueueItem[]): ReviewSelectionSummary {
  return items.reduce<ReviewSelectionSummary>((summary, item) => {
    const signals = getReviewCardSignals(item);
    summary.total += 1;
    if (signals.hasLowConfidence) summary.lowConfidence += 1;
    if (signals.hasMissingSku) summary.missingSku += 1;
    if (signals.isDuplicate) summary.duplicates += 1;
    return summary;
  }, { total: 0, lowConfidence: 0, missingSku: 0, duplicates: 0 });
}
