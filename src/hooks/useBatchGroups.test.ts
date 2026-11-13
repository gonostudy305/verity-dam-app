import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBatchGroups } from './useBatchGroups';
import type { ReviewQueueItem, MediaAsset } from '@/types/media';
import { mapBatchGroupsForGrid } from '@/components/review/review-grid-groups';

function createMockQueueItem(overrides: Partial<ReviewQueueItem> & { assetOverrides?: Partial<MediaAsset> }): ReviewQueueItem {
  const { assetOverrides, ...itemOverrides } = overrides;
  const asset: MediaAsset = {
    id: 'asset-' + Math.random().toString(36).substring(7),
    title: 'Test Photo',
    file_url: 'https://example.com/image.webp',
    thumbnail_url: 'https://example.com/thumb.webp',
    media_type: 'photo',
    sku: '',
    brand: '',
    category: 'Ảnh thực tế',
    status: 'Mới',
    permission: 'public',
    ai_flags: {
      is_ai: false,
      is_internal: false,
      has_people: false,
      tag_failed: false,
      is_broken: false,
    },
    ai_confidence: {
      sku: 0,
      brand: 0,
      category: 0,
      space: 0,
      status: 0,
    },
    phash: '0000000000000000',
    dimensions: { width: 1200, height: 800, size_bytes: 100000 },
    origin_info: { source: 'Upload' },
    usage_count: 0,
    created_at: new Date('2026-09-10T08:00:00Z').toISOString(),
    ...assetOverrides,
  };

  return {
    id: 'queue-' + Math.random().toString(36).substring(7),
    asset,
    status: 'pending',
    is_duplicate: false,
    user_corrections: {},
    suggested_caption: '',
    created_at: asset.created_at,
    ...itemOverrides,
  };
}

test('calculateBatchGroups groups by import_batch_id as primary tier', () => {
  const item1 = createMockQueueItem({
    assetOverrides: {
      title: 'Lyra front',
      origin_info: { source: 'GDrive', import_batch_id: 'batch-lyra-01', batch_context: 'GDrive Lyra WB08' },
    },
  });
  const item2 = createMockQueueItem({
    assetOverrides: {
      title: 'Lyra mortise',
      origin_info: { source: 'GDrive', import_batch_id: 'batch-lyra-01', batch_context: 'GDrive Lyra WB08' },
    },
  });
  const item3 = createMockQueueItem({
    assetOverrides: {
      title: 'Acme lock',
      origin_info: { source: 'GDrive', import_batch_id: 'batch-acme-02', batch_context: 'GDrive Acme A100' },
    },
  });

  const groups = calculateBatchGroups([item1, item2, item3]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].key, 'import:batch-lyra-01');
  assert.equal(groups[0].indices.length, 2);
  assert.equal(groups[0].label, 'Lô: GDrive Lyra WB08');
  assert.equal(groups[1].key, 'import:batch-acme-02');
  assert.equal(groups[1].indices.length, 1);
});

test('calculateBatchGroups groups by batch_id as secondary tier', () => {
  const item1 = createMockQueueItem({
    assetOverrides: {
      title: 'Showroom 1',
      origin_info: { source: 'Upload', batch_id: 'web-batch-101', project_name: 'Showroom Q7' },
    },
  });
  const item2 = createMockQueueItem({
    assetOverrides: {
      title: 'Showroom 2',
      origin_info: { source: 'Upload', batch_id: 'web-batch-101', project_name: 'Showroom Q7' },
    },
  });

  const groups = calculateBatchGroups([item1, item2]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'upload:web-batch-101');
  assert.equal(groups[0].indices.length, 2);
  assert.equal(groups[0].label, 'Lô: Showroom Q7');
});

test('calculateBatchGroups groups consecutive items by time window when no batch ID is present', () => {
  const baseTime = new Date('2026-09-10T10:00:00Z').getTime();
  const item1 = createMockQueueItem({
    created_at: new Date(baseTime).toISOString(),
    assetOverrides: { title: 'Photo 1' },
  });
  const item2 = createMockQueueItem({
    created_at: new Date(baseTime + 20_000).toISOString(), // 20s later
    assetOverrides: { title: 'Photo 2' },
  });
  const item3 = createMockQueueItem({
    created_at: new Date(baseTime + 180_000).toISOString(), // 3 mins later
    assetOverrides: { title: 'Photo 3' },
  });

  const groups = calculateBatchGroups([item1, item2, item3]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].indices.length, 2);
  assert.equal(groups[1].indices.length, 1);
});

test('calculateBatchGroups extracts best suggestedSku and confidence from items in the group', () => {
  const item1 = createMockQueueItem({
    assetOverrides: {
      sku: '',
      ai_confidence: { sku: 0, brand: 0, category: 0, space: 0, status: 0 },
      origin_info: { source: 'GDrive', import_batch_id: 'batch-lyra' },
    },
  });
  const item2 = createMockQueueItem({
    sku_match: {
      sku: 'WB08',
      similarity: 0.94,
      source: 'embedding_reference',
    },
    assetOverrides: {
      sku: 'WB08',
      brand: 'Lyra',
      ai_confidence: { sku: 94, brand: 95, category: 90, space: 80, status: 90 },
      origin_info: { source: 'GDrive', import_batch_id: 'batch-lyra' },
    },
  });

  const groups = calculateBatchGroups([item1, item2]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].suggestedSku, 'WB08');
  assert.equal(groups[0].suggestedSkuConfidence, 94);
  assert.equal(groups[0].suggestedBrand, 'Lyra');
});

test('maps legacy group indices to stable queue IDs for the Grid', () => {
  const item1 = createMockQueueItem({
    assetOverrides: { origin_info: { source: 'Upload', batch_id: 'same-lot' } },
  });
  const item2 = createMockQueueItem({
    assetOverrides: { origin_info: { source: 'Upload', batch_id: 'same-lot' } },
  });
  const singleton = createMockQueueItem({
    assetOverrides: { origin_info: { source: 'Upload', batch_id: 'solo-lot' } },
  });
  const queue = [item1, item2, singleton];
  const groups = mapBatchGroupsForGrid(queue, calculateBatchGroups(queue));

  assert.deepEqual(groups[0].itemIds, [item1.id, item2.id]);
  assert.equal(groups[0].isVisualGroup, true);
  assert.deepEqual(groups[1].itemIds, [singleton.id]);
  assert.equal(groups[1].isVisualGroup, false);
});
