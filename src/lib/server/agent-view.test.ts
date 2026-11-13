import assert from 'node:assert/strict';
import test from 'node:test';

import { composeAgentDescription } from './agent-view';
import type { MediaAsset } from '@/types/media';

function createMockAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'test-asset-1',
    title: 'Camera Hub G3',
    file_url: 'https://cdn.veritydam.example/photo.jpg',
    thumbnail_url: 'https://cdn.veritydam.example/thumb.jpg',
    media_type: 'photo',
    sku: 'AC-H03',
    brand: 'Acme',
    category: 'Công trình',
    space: 'Phòng khách',
    status: 'Đã bàn giao',
    permission: 'public',
    ai_flags: { has_people: false, is_ai: false, is_internal: false, tag_failed: false },
    ai_confidence: { sku: 0.95, category: 0.98, brand: 0.99 },
    phash: '1111000011110000',
    dimensions: { width: 1920, height: 1080, size_bytes: 102400 },
    origin_info: { source: 'Upload' },
    usage_count: 0,
    created_at: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

test('composeAgentDescription produces rich composite string when all fields present', () => {
  const asset = createMockAsset({
    suggested_caption: 'Camera Hub G3 gắn trên trần phòng khách',
    keywords: ['camera', 'acme', 'hub g3'],
    category: 'Công trình',
    space: 'Phòng khách',
    brand: 'Acme',
    status: 'Đã bàn giao',
  });

  const res = composeAgentDescription(asset);
  assert.equal(
    res,
    'Camera Hub G3 gắn trên trần phòng khách | Từ khóa: camera, acme, hub g3 | Danh mục: Công trình | Không gian: Phòng khách | Thương hiệu: Acme | Trạng thái: Đã bàn giao'
  );
  assert.ok(!res.includes('undefined'));
  assert.ok(!res.includes('null'));
});

test('composeAgentDescription gracefully handles missing optional fields without undefined or null', () => {
  const asset = createMockAsset({
    suggested_caption: undefined,
    keywords: undefined,
    category: 'Showroom',
    space: undefined,
    brand: 'Acme',
    status: 'Mới',
  });

  const res = composeAgentDescription(asset);
  assert.equal(res, 'Danh mục: Showroom | Thương hiệu: Acme | Trạng thái: Mới');
  assert.ok(!res.includes('undefined'));
  assert.ok(!res.includes('null'));
});

test('composeAgentDescription returns empty string on empty asset without crashing', () => {
  const asset = createMockAsset({
    suggested_caption: undefined,
    keywords: [],
    category: '',
    space: undefined,
    brand: '',
    status: '' as any,
  });

  const res = composeAgentDescription(asset);
  assert.equal(res, '');
});

test('composeAgentDescription ignores empty keywords array and trims caption', () => {
  const asset = createMockAsset({
    suggested_caption: '   Khóa cửa Acme M100 Zigbee   ',
    keywords: [],
    category: 'Showroom',
    space: 'Cửa chính',
    brand: 'Acme',
    status: 'Mới',
  });

  const res = composeAgentDescription(asset);
  assert.equal(
    res,
    'Khóa cửa Acme M100 Zigbee | Danh mục: Showroom | Không gian: Cửa chính | Thương hiệu: Acme | Trạng thái: Mới'
  );
  assert.ok(!res.includes('Từ khóa:'));
});

test('composeAgentDescription includes visible_text when present', () => {
  const asset = createMockAsset({
    suggested_caption: 'Khóa cổng thông minh Verity C02',
    visible_text: ['Verity', 'home appliance'],
    brand: 'Verity',
  });

  const res = composeAgentDescription(asset);
  assert.ok(res.includes('Văn bản nhìn thấy: Verity, home appliance'));
  assert.ok(res.includes('Thương hiệu: Verity'));
});
