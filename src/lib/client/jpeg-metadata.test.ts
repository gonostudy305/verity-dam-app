import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExifSegment, buildIptcSegment, injectJpegMetadata } from './jpeg-metadata';
import type { MediaAsset } from '@/types/media';

const mockAsset: MediaAsset = {
  id: 'test-asset-1234',
  sku: 'DEMO-007',
  brand: 'EDEN',
  title: 'Khóa vân tay thông minh EDEN DL05',
  author: 'VerityDAM Platform',
  copyright: '© 2026 VerityDAM Platform. All rights reserved.',
  credit: 'VerityDAM Team',
  description: 'Khóa cửa điện tử thông minh cao cấp kết nối Zigbee/Wifi.',
  suggested_caption: 'Khóa vân tay EDEN DL05 thông minh',
  keywords: ['eden', 'dl05', 'khoa-van-tay', 'smart-lock'],
  category: 'Banner',
  space: 'Cửa chính',
  status: 'Mới',
  permission: 'public',
  media_type: 'photo',
  file_url: 'https://cdn.veritydam.example/sample.jpg',
  thumbnail_url: 'https://cdn.veritydam.example/sample-thumb.jpg',
  ai_confidence: { sku: 0.99, brand: 0.99, category: 0.99 },
  ai_flags: { is_ai: false, is_internal: false, has_people: false, tag_failed: false },
  phash: '0000000000000000',
  dimensions: { width: 1200, height: 1200, size_bytes: 500000 },
  origin_info: { source: 'Upload', uploader: 'tester', uploader_email: 'tester@veritydam.example' },
  usage_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

test('buildExifSegment creates valid APP1 EXIF segment with tags', () => {
  const exif = buildExifSegment(mockAsset);
  assert.ok(exif.length > 0);
  assert.equal(exif[0], 0xff);
  assert.equal(exif[1], 0xe1); // APP1 Marker

  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(exif);
  assert.ok(text.includes('Exif'));
  assert.ok(text.includes('EDEN'));
  assert.ok(text.includes('DEMO-007'));
  assert.ok(text.includes('VerityDAM Platform'));
  assert.ok(text.includes('VerityDAM Studio'));
});

test('buildIptcSegment creates valid APP13 IPTC-NAA segment with keywords and author', () => {
  const iptc = buildIptcSegment(mockAsset);
  assert.ok(iptc.length > 0);
  assert.equal(iptc[0], 0xff);
  assert.equal(iptc[1], 0xed); // APP13 Marker

  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(iptc);
  assert.ok(text.includes('Photoshop 3.0'));
  assert.ok(text.includes('8BIM'));
  assert.ok(text.includes('VerityDAM Platform'));
  assert.ok(text.includes('khoa-van-tay'));
  assert.ok(text.includes('eden'));
});

test('injectJpegMetadata embeds APP1 and APP13 into raw JPEG without corrupting data', async () => {
  // Minimal valid JPEG with SOI (FF D8), DQT (FF DB), and EOI (FF D9)
  const rawJpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT
    0xff, 0xd9, // EOI
  ]);

  const rawBlob = new Blob([rawJpeg], { type: 'image/jpeg' });
  const enrichedBlob = await injectJpegMetadata(rawBlob, mockAsset);

  assert.equal(enrichedBlob.type, 'image/jpeg');
  const enrichedBuf = new Uint8Array(await enrichedBlob.arrayBuffer());

  // Must still start with SOI (FF D8)
  assert.equal(enrichedBuf[0], 0xff);
  assert.equal(enrichedBuf[1], 0xd8);

  // Must contain APP1 (FF E1) and APP13 (FF ED)
  let hasApp1 = false;
  let hasApp13 = false;
  for (let i = 0; i < enrichedBuf.length - 1; i++) {
    if (enrichedBuf[i] === 0xff && enrichedBuf[i + 1] === 0xe1) hasApp1 = true;
    if (enrichedBuf[i] === 0xff && enrichedBuf[i + 1] === 0xed) hasApp13 = true;
  }

  assert.ok(hasApp1, 'Enriched JPEG must contain APP1 EXIF segment');
  assert.ok(hasApp13, 'Enriched JPEG must contain APP13 IPTC segment');
});