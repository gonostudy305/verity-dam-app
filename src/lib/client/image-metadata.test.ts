import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTiffExifBuffer,
  buildExifSegment,
  buildIptcSegment,
  injectJpegMetadata,
  injectPngMetadata,
  injectWebpMetadata,
  injectImageMetadata,
} from './image-metadata';
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

test('buildTiffExifBuffer creates valid TIFF IFD0 structure with tags', () => {
  const tiff = buildTiffExifBuffer(mockAsset);
  assert.ok(tiff.length > 0);
  // Little Endian TIFF header 'II' (0x49, 0x49) + 42 (0x2A, 0x00)
  assert.equal(tiff[0], 0x49);
  assert.equal(tiff[1], 0x49);
  assert.equal(tiff[2], 0x2a);
  assert.equal(tiff[3], 0x00);

  const decoder = new TextDecoder('utf-8');
  const text = decoder.decode(tiff);
  assert.ok(text.includes('EDEN'));
  assert.ok(text.includes('DEMO-007'));
  assert.ok(text.includes('VerityDAM Platform'));
  assert.ok(text.includes('VerityDAM Studio'));
});

test('injectJpegMetadata embeds APP1 and APP13 into JPEG', async () => {
  const rawJpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT
    0xff, 0xd9, // EOI
  ]);

  const rawBlob = new Blob([rawJpeg], { type: 'image/jpeg' });
  const enrichedBlob = await injectJpegMetadata(rawBlob, mockAsset);

  assert.equal(enrichedBlob.type, 'image/jpeg');
  const enrichedBuf = new Uint8Array(await enrichedBlob.arrayBuffer());

  assert.equal(enrichedBuf[0], 0xff);
  assert.equal(enrichedBuf[1], 0xd8);

  let hasApp1 = false;
  let hasApp13 = false;
  for (let i = 0; i < enrichedBuf.length - 1; i++) {
    if (enrichedBuf[i] === 0xff && enrichedBuf[i + 1] === 0xe1) hasApp1 = true;
    if (enrichedBuf[i] === 0xff && enrichedBuf[i + 1] === 0xed) hasApp13 = true;
  }
  assert.ok(hasApp1, 'JPEG must contain APP1 EXIF segment');
  assert.ok(hasApp13, 'JPEG must contain APP13 IPTC segment');
});

test('injectPngMetadata embeds iTXt and eXIf chunks into PNG without corrupting chunks', async () => {
  // Minimal valid PNG structure: 8B Signature + IHDR (25B) + IEND (12B)
  const rawPng = new Uint8Array([
    // Signature
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR chunk (13 bytes payload)
    0x00, 0x00, 0x00, 0x0d, // Length = 13
    0x49, 0x48, 0x44, 0x52, // 'IHDR'
    0x00, 0x00, 0x04, 0xb0, // Width = 1200
    0x00, 0x00, 0x04, 0xb0, // Height = 1200
    0x08, 0x06, 0x00, 0x00, 0x00, // Bit depth 8, ColorType 6 (RGBA), Deflate, Filter, Interlace
    0x57, 0x24, 0x5e, 0x3d, // CRC
    // IEND chunk
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);

  const rawBlob = new Blob([rawPng], { type: 'image/png' });
  const enrichedBlob = await injectPngMetadata(rawBlob, mockAsset);

  assert.equal(enrichedBlob.type, 'image/png');
  const enrichedBuf = new Uint8Array(await enrichedBlob.arrayBuffer());

  // Signature check
  assert.equal(enrichedBuf[0], 0x89);
  assert.equal(enrichedBuf[1], 0x50);

  const text = new TextDecoder('utf-8').decode(enrichedBuf);
  assert.ok(text.includes('iTXt'), 'PNG must contain iTXt chunk');
  assert.ok(text.includes('eXIf'), 'PNG must contain eXIf chunk');
  assert.ok(text.includes('VerityDAM Platform'));
  assert.ok(text.includes('DEMO-007'));
  assert.ok(text.includes('khoa-van-tay'));
});

test('injectWebpMetadata converts Simple WebP to Extended WebP with VP8X and EXIF chunk', async () => {
  // Minimal valid Simple WebP with VP8 bitstream
  const rawWebp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x1c, 0x00, 0x00, 0x00, // File size = 28
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x20, // 'VP8 '
    0x10, 0x00, 0x00, 0x00, // Chunk size = 16
    0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, // VP8 keyframe header
    0xb0, 0x04, 0xb0, 0x04, // 1200 x 1200
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);

  const rawBlob = new Blob([rawWebp], { type: 'image/webp' });
  const enrichedBlob = await injectWebpMetadata(rawBlob, mockAsset);

  assert.equal(enrichedBlob.type, 'image/webp');
  const enrichedBuf = new Uint8Array(await enrichedBlob.arrayBuffer());

  // RIFF header check
  assert.equal(enrichedBuf[0], 0x52); // 'R'
  assert.equal(enrichedBuf[1], 0x49); // 'I'
  assert.equal(enrichedBuf[2], 0x46); // 'F'
  assert.equal(enrichedBuf[3], 0x46); // 'F'

  const text = new TextDecoder('utf-8').decode(enrichedBuf);
  assert.ok(text.includes('VP8X'), 'WebP must contain VP8X extended header chunk');
  assert.ok(text.includes('EXIF'), 'WebP must contain EXIF chunk');
  assert.ok(text.includes('EDEN'));
  assert.ok(text.includes('DEMO-007'));
  assert.ok(text.includes('VerityDAM Platform'));
});

test('injectImageMetadata automatically dispatches by format and MIME', async () => {
  const rawPng = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
    0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);

  const pngBlob = new Blob([rawPng], { type: 'image/png' });
  const result = await injectImageMetadata(pngBlob, mockAsset, 'png');
  assert.equal(result.type, 'image/png');

  const text = new TextDecoder('utf-8').decode(new Uint8Array(await result.arrayBuffer()));
  assert.ok(text.includes('iTXt'));
});

test('injectJpegMetadata deduplicates existing APP1/APP13 segments on re-injection', async () => {
  const rawJpeg = new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, // DQT
    0xff, 0xd9, // EOI
  ]);
  const initialBlob = await injectJpegMetadata(new Blob([rawJpeg], { type: 'image/jpeg' }), mockAsset);
  // Re-inject into already enriched JPEG
  const secondBlob = await injectJpegMetadata(initialBlob, mockAsset);

  const buf = new Uint8Array(await secondBlob.arrayBuffer());
  let app1Count = 0;
  let app13Count = 0;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xe1) app1Count++;
    if (buf[i] === 0xff && buf[i + 1] === 0xed) app13Count++;
  }
  assert.equal(app1Count, 1, 'Re-injected JPEG must contain exactly ONE APP1 segment');
  assert.equal(app13Count, 1, 'Re-injected JPEG must contain exactly ONE APP13 segment');
});

test('injectWebpMetadata deduplicates existing EXIF chunks on re-injection', async () => {
  const rawWebp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x1c, 0x00, 0x00, 0x00, // File size = 28
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x20, // 'VP8 '
    0x10, 0x00, 0x00, 0x00, // Chunk size = 16
    0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a,
    0xb0, 0x04, 0xb0, 0x04,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const initialBlob = await injectWebpMetadata(new Blob([rawWebp], { type: 'image/webp' }), mockAsset);
  // Re-inject into already enriched WebP
  const secondBlob = await injectWebpMetadata(initialBlob, mockAsset);

  const buf = new Uint8Array(await secondBlob.arrayBuffer());
  let exifCount = 0;
  let offset = 12;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) break;
    const tag = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const chunkSize = buf[offset + 4] | (buf[offset + 5] << 8) | (buf[offset + 6] << 16) | (buf[offset + 7] << 24);
    if (tag === 'EXIF') exifCount++;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  assert.equal(exifCount, 1, 'Re-injected WebP must contain exactly ONE EXIF chunk');
});