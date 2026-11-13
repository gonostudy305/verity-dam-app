import test from 'node:test';
import assert from 'node:assert/strict';
import type { AIConfidence, AIFlags, MediaPermission, ReviewQueueItem } from '@/types/media';
import { getReviewCardSignals, normalizeReviewConfidence, REVIEW_CONFIDENCE_ATTENTION_THRESHOLD } from './review-card-signals';

interface AssetSignalOverrides {
  sku?: string;
  permission?: MediaPermission;
  ai_flags?: Partial<AIFlags>;
  ai_confidence?: Partial<AIConfidence>;
}

function item(overrides: AssetSignalOverrides = {}): ReviewQueueItem {
  const { ai_flags, ai_confidence, ...assetOverrides } = overrides;
  return {
    id: 'queue-1',
    is_duplicate: false,
    asset: {
      sku: 'A100',
      permission: 'public',
      ...assetOverrides,
      ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false, ...ai_flags },
      ai_confidence: { sku: 0.9, brand: 0, category: 0, ...ai_confidence },
    },
  } as ReviewQueueItem;
}

test('normalizes both model floats and percentages for review card signals', () => {
  assert.equal(normalizeReviewConfidence(0.84), 84);
  assert.equal(normalizeReviewConfidence(85), 85);
  assert.equal(normalizeReviewConfidence(undefined), null);
  assert.equal(REVIEW_CONFIDENCE_ATTENTION_THRESHOLD, 85);
});

test('surfaces only real review warnings on an overview card', () => {
  const warningItem = item({ sku: '', permission: 'internal', ai_flags: { has_people: true }, ai_confidence: { sku: 0.72 } });
  warningItem.is_duplicate = true;

  assert.deepEqual(getReviewCardSignals(warningItem), {
    confidence: 72,
    hasLowConfidence: true,
    hasMissingSku: true,
    isInternal: true,
    hasPeople: true,
    isDuplicate: true,
    needsPostProduction: false,
  });

  const postProdItem = item();
  postProdItem.asset.needs_post_production = true;
  assert.equal(getReviewCardSignals(postProdItem).needsPostProduction, true);
});
