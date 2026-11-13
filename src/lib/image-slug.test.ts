import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildPublicImageSlug } from './image-slug';

const parityFixtures = JSON.parse(
  readFileSync(new URL('../../shared/canonical-media-slug-fixtures.json', import.meta.url), 'utf8'),
) as Array<{ input: Parameters<typeof buildPublicImageSlug>[0]; slug: string }>;

test('Python and TypeScript canonical-slug parity fixtures stay exact', () => {
  for (const fixture of parityFixtures) {
    assert.equal(buildPublicImageSlug(fixture.input), fixture.slug);
  }
});

test('buildPublicImageSlug constructs slug from brand, sku, and title', () => {
  const slug = buildPublicImageSlug({
    brand: 'Bear',
    sku: 'EB-5H15D',
    title: 'Ấm đun nước 1.5L',
  });
  assert.equal(slug, 'bear-eb-5h15d-am-dun-nuoc-1-5l');
});

test('buildPublicImageSlug handles empty/em-dash brand or sku correctly', () => {
  const slug = buildPublicImageSlug({
    brand: '—',
    sku: '',
    title: 'Thiết kế chưa có tên 1',
  });
  assert.equal(slug, 'thiet-ke-chua-co-ten-1');
});

test('buildPublicImageSlug falls back to asset id prefix when metadata is empty', () => {
  const slug = buildPublicImageSlug({
    id: '9b9d7cc0-ba1f-49b3-8596-85f640efaa79',
    brand: '',
    sku: '',
    title: '',
  });
  assert.equal(slug, '9b9d7cc0');
});

test('buildPublicImageSlug falls back to "asset" when everything is empty', () => {
  const slug = buildPublicImageSlug({});
  assert.equal(slug, 'asset');
});

test('buildPublicImageSlug handles special characters and collapses hyphens', () => {
  const slug = buildPublicImageSlug({
    brand: 'Acme',
    sku: 'M100 [Zigbee Edition]',
    title: 'Khóa cửa thông minh (Màu đen / Bạc)!',
  });
  assert.equal(slug, 'acme-m100-zigbee-edition-khoa-cua-thong-minh-mau-den-bac');
});

test('buildPublicImageSlug caps output at 120 chars', () => {
  const longTitle = 'a'.repeat(120);
  const slug = buildPublicImageSlug({ title: longTitle });
  assert.ok(slug.length <= 120);
});

test('isGenericOrRawTitle identifies junk or camera raw upload filenames', () => {
  const { isGenericOrRawTitle } = require('./image-slug');
  assert.equal(isGenericOrRawTitle('ChatGPT Image Sep 3, 2026, 04_33_05 PM'), true);
  assert.equal(isGenericOrRawTitle('Thiet-ke-chua-co-ten-1'), true);
  assert.equal(isGenericOrRawTitle('Thiết kế chưa có tên'), true);
  assert.equal(isGenericOrRawTitle('IMG_20260907_143000'), true);
  assert.equal(isGenericOrRawTitle('Screenshot 2026-09-07 at 2.30.00 PM'), true);
  assert.equal(isGenericOrRawTitle('banner-homepage.png'), true);
  assert.equal(isGenericOrRawTitle('d3245ec6-be85-4712-aea8-c000e304986e'), true);
  assert.equal(isGenericOrRawTitle('Upload'), true);
  assert.equal(isGenericOrRawTitle('16'), true);
  assert.equal(isGenericOrRawTitle('001'), true);
  assert.equal(isGenericOrRawTitle('Untitled'), true);
  assert.equal(isGenericOrRawTitle('—'), true);
  assert.equal(isGenericOrRawTitle(''), true);
  assert.equal(isGenericOrRawTitle(null), true);

  // Legitimate product titles should not be marked generic
  assert.equal(isGenericOrRawTitle('Khóa vân tay thông minh cửa nhôm Verity S610'), false);
  assert.equal(isGenericOrRawTitle('Ấm đun nước siêu tốc Bear 1.5L'), false);
  assert.equal(isGenericOrRawTitle('Robot hút bụi lau nhà Ecolo X2 OMNI'), false);
});

test('composeAssetTitle generates meaningful title for generic titles', () => {
  const { composeAssetTitle } = require('./image-slug');

  // Generic raw file with entity and context
  const res1 = composeAssetTitle({
    title: '900x900 (100).webp',
    brand: 'Verity',
    sku: 'Verity C02',
    space: 'Cửa chính',
    category: 'Công trình',
  });
  assert.equal(res1, 'Verity C02 - Cửa chính');

  // Specific title preserved
  const res2 = composeAssetTitle({
    title: 'Khóa cổng thông minh Verity C02 chính hãng',
    brand: 'Verity',
    sku: 'Verity C02',
  });
  assert.equal(res2, 'Khóa cổng thông minh Verity C02 chính hãng');

  // Generic camera filename with caption fallback
  const res3 = composeAssetTitle({
    title: 'IMG_9413.jpg',
    brand: 'EDEN',
    sku: 'DEMO-007',
    suggested_caption: 'Khóa cửa thông minh EDEN lắp trên cửa gỗ. Thiết bị hoàn thiện.',
  });
  assert.equal(res3, 'EDEN DEMO-007 - Khóa cửa thông minh EDEN lắp trên cửa gỗ');

  // No-entity (no brand, no SKU) with category and space
  const res4 = composeAssetTitle({
    title: 'IMG_1234.jpg',
    brand: '',
    sku: '',
    category: 'Công trình',
    space: 'Phòng khách',
  });
  assert.equal(res4, 'Công trình - Phòng khách');

  // No-entity with category only
  const res5 = composeAssetTitle({
    title: 'banner.png',
    category: 'Banner',
  });
  assert.equal(res5, 'Banner');

  // No-entity with space only
  const res6 = composeAssetTitle({
    title: 'raw_photo.jpg',
    space: 'Sân vườn',
  });
  assert.equal(res6, 'Sân vườn');

  // No-entity, no category/space -> caption fallback
  const res7 = composeAssetTitle({
    title: 'DSC_0001.jpg',
    suggested_caption: 'Toàn cảnh ngôi nhà hiện đại với hệ thống điện thông minh.',
  });
  assert.equal(res7, 'Toàn cảnh ngôi nhà hiện đại với hệ thống điện thông minh');
});
