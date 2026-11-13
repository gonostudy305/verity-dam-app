import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateJustifiedLayout } from './useJustifiedLayout';
import type { MediaAsset } from '@/types/media';

function createMockAsset(id: string, width: number, height: number): MediaAsset {
  return {
    id,
    title: `Asset ${id}`,
    file_url: `https://example.com/${id}.jpg`,
    thumbnail_url: `https://example.com/${id}_thumb.jpg`,
    media_type: 'photo',
    sku: 'TEST-SKU',
    brand: 'Verity',
    category: 'Ảnh thực tế',
    status: 'active',
    permission: 'public',
    ai_flags: {
      is_ai: false,
      is_internal: false,
      has_people: false,
      tag_failed: false,
    },
    ai_confidence: {
      sku: 90,
      brand: 90,
      category: 90,
    },
    phash: '0000000000000000',
    dimensions: {
      width,
      height,
      size_bytes: 1024,
    },
    origin_info: {
      source: 'Upload',
    },
    usage_count: 0,
    created_at: '2026-09-21T00:00:00Z',
  };
}

describe('calculateJustifiedLayout algorithm', () => {
  it('returns empty array when containerWidth is 0 or negative', () => {
    const assets = [createMockAsset('1', 800, 600)];
    const rows = calculateJustifiedLayout({ items: assets, containerWidth: 0, targetRowHeight: 260, gap: 12 });
    assert.deepEqual(rows, []);
  });

  it('partitions multiple items into justified rows filling container width', () => {
    const assets = [
      createMockAsset('1', 800, 600),  // 4:3 = 1.33
      createMockAsset('2', 1200, 800), // 3:2 = 1.5
      createMockAsset('3', 1920, 1080),// 16:9 = 1.78
      createMockAsset('4', 600, 600),  // 1:1 = 1.0
      createMockAsset('5', 800, 1200), // 2:3 = 0.67
    ];
    const containerWidth = 1200;
    const gap = 12;
    const targetRowHeight = 260;

    const rows = calculateJustifiedLayout({ items: assets, containerWidth, targetRowHeight, gap });

    assert.ok(rows.length >= 1, 'Should create at least 1 row');
    
    // First row should fill container width
    const firstRow = rows[0];
    const firstRowItemsWidth = firstRow.items.reduce((acc, item) => acc + item.width, 0);
    const gapsTotal = (firstRow.items.length - 1) * gap;
    
    if (!firstRow.isLastRow) {
      assert.equal(firstRowItemsWidth + gapsTotal, containerWidth, 'Full row must equal container width');
    }
  });

  it('handles single item or last row without exploding height', () => {
    const assets = [createMockAsset('1', 800, 600)];
    const containerWidth = 1400;
    const targetRowHeight = 260;
    const rows = calculateJustifiedLayout({ items: assets, containerWidth, targetRowHeight, gap: 12 });

    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row.isLastRow);
    assert.equal(row.height, targetRowHeight, 'Last row height must stay bounded to targetRowHeight');
  });
});
