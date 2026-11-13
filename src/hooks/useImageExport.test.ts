import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSmartFilename,
  sanitizeWindowsFilename,
  removeVietnameseAccents,
  sanitizeFilenameInput,
} from './useImageExport';
import type { MediaAsset } from '@/types/media';

test('buildSmartFilename generates standardized Verity filenames', () => {
  const dummyAsset = {
    id: 'f5d61e7d-8e0a-41de-bab2-e5108cfdbd69',
    file_url: 'https://example.com/image.jpg',
    thumbnail_url: 'https://example.com/thumb.jpg',
    title: 'Khóa cửa Acme D200',
    sku: 'DL-D02D-B',
    brand: 'Acme',
    category: 'Showroom',
    status: 'new',
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    permission: 'public',
  } as unknown as MediaAsset;

  const filenameZalo = buildSmartFilename(dummyAsset, 'zalo_1200px', 'jpg');
  assert.equal(filenameZalo, 'VERITY_DL-D02D-B_Acme_zalo_1200px.jpg');

  const filenameWeb = buildSmartFilename(dummyAsset, 'web', 'webp');
  assert.equal(filenameWeb, 'VERITY_DL-D02D-B_Acme_web.webp');

  const filenameCropJpg = buildSmartFilename(dummyAsset, 'crop_1x1', 'jpg');
  assert.equal(filenameCropJpg, 'VERITY_DL-D02D-B_Acme_crop_1x1.jpg');

  const filenameCropPng = buildSmartFilename(dummyAsset, 'crop_1x1', 'png');
  assert.equal(filenameCropPng, 'VERITY_DL-D02D-B_Acme_crop_1x1.png');

  const filenameCropWebp = buildSmartFilename(dummyAsset, 'crop_16x9', 'webp');
  assert.equal(filenameCropWebp, 'VERITY_DL-D02D-B_Acme_crop_16x9.webp');
});

test('buildSmartFilename sanitizes special characters and falls back when SKU is missing', () => {
  const dummyAsset = {
    id: 'f5d61e7d-8e0a-41de-bab2-e5108cfdbd69',
    file_url: 'https://example.com/image.jpg',
    thumbnail_url: 'https://example.com/thumb.jpg',
    title: 'Camera Test',
    sku: undefined,
    brand: 'Nova / Acme',
    category: 'Công trình',
    status: 'new',
    created_at: '2026-08-26T00:00:00Z',
    updated_at: '2026-08-26T00:00:00Z',
    permission: 'public',
  } as unknown as MediaAsset;

  const filename = buildSmartFilename(dummyAsset, 'original', 'png');
  assert.equal(filename, 'VERITY_f5d61e7d_Nova-Acme_original.png');
});

test('buildSmartFilename uses canonical_slug when available for original and web suffixes', () => {
  const dummyAsset = {
    id: 'f5d61e7d-8e0a-41de-bab2-e5108cfdbd69',
    file_url: 'https://assets.verity.internal/canonical/verity-sl108-test.webp',
    canonical_slug: 'verity-sl108-nha-xuong-khoa-cua-dien-tu-mau-den-lap-tren-cua-nhom-kinh-khung-xam',
    sku: 'Verity SL108',
    brand: 'Verity',
  } as unknown as MediaAsset;

  const filenameOriginal = buildSmartFilename(dummyAsset, 'original', 'webp');
  assert.equal(
    filenameOriginal,
    'verity-sl108-nha-xuong-khoa-cua-dien-tu-mau-den-lap-tren-cua-nhom-kinh-khung-xam.webp'
  );

  const filenameWeb = buildSmartFilename(dummyAsset, 'web', '.webp');
  assert.equal(
    filenameWeb,
    'verity-sl108-nha-xuong-khoa-cua-dien-tu-mau-den-lap-tren-cua-nhom-kinh-khung-xam.webp'
  );

  // Crop exports still use structured names with suffix
  const filenameCrop = buildSmartFilename(dummyAsset, 'crop_1x1', 'webp');
  assert.equal(filenameCrop, 'VERITY_Verity-SL108_Verity_crop_1x1.webp');
});

test('getCorsSafeUrl appends cors=1 query param idempotently to external URLs', () => {
  const { getCorsSafeUrl } = require('./useImageExport');

  // Plain URL appends ?cors=1
  assert.equal(
    getCorsSafeUrl('https://assets.verity.internal/photo.webp'),
    'https://assets.verity.internal/photo.webp?cors=1'
  );

  // URL with existing query param appends &cors=1
  assert.equal(
    getCorsSafeUrl('https://assets.verity.internal/photo.webp?v=2'),
    'https://assets.verity.internal/photo.webp?v=2&cors=1'
  );

  // Idempotency: already has cors=1, does not append duplicate
  assert.equal(
    getCorsSafeUrl('https://assets.verity.internal/photo.webp?cors=1'),
    'https://assets.verity.internal/photo.webp?cors=1'
  );
  assert.equal(
    getCorsSafeUrl('https://assets.verity.internal/photo.webp?foo=bar&cors=1'),
    'https://assets.verity.internal/photo.webp?foo=bar&cors=1'
  );

  // Non-http or empty string returned unchanged
  assert.equal(getCorsSafeUrl(''), '');
  assert.equal(getCorsSafeUrl('/relative/path.webp'), '/relative/path.webp');
});

test('sanitizeWindowsFilename strips illegal Windows characters and normalizes extensions', () => {
  // Strips Windows reserved characters: \ / : * ? " < > |
  assert.equal(
    sanitizeWindowsFilename('khoa-cua-nhom-lyra-xf19-3-7//e5a-/68x/68.webp'),
    'khoa-cua-nhom-lyra-xf19-3-7-e5a-68x-68.webp'
  );
  assert.equal(
    sanitizeWindowsFilename('Ảnh Cửa: Khóa "Lyra" <A12> *Đẹp*?|yes.png'),
    'Anh-Cua-Khoa-Lyra-A12-Dep-yes.png'
  );
  assert.equal(
    sanitizeWindowsFilename('custom-file-name', 'jpg'),
    'custom-file-name.jpg'
  );
  assert.equal(
    sanitizeWindowsFilename('   test   name   .webp   '),
    'test-name.webp'
  );
  assert.equal(
    sanitizeWindowsFilename('', 'webp'),
    'asset.webp'
  );
});

test('buildSmartFilename sanitizes canonical_slug if it contains slashes or path fragments', () => {
  const malformedAsset = {
    id: 'f5d61e7d-8e0a-41de-bab2-e5108cfdbd69',
    file_url: 'https://assets.verity.internal/canonical/photo.webp',
    canonical_slug: 'khoa-cua-nhom-lyra-xf19-3-7//e5a-/68x/68',
    sku: 'LF-A12',
    brand: 'Lyra',
  } as unknown as MediaAsset;

  const filenameOriginal = buildSmartFilename(malformedAsset, 'original', 'webp');
  assert.equal(
    filenameOriginal,
    'khoa-cua-nhom-lyra-xf19-3-7-e5a-68x-68.webp'
  );
  assert.ok(!filenameOriginal.includes('/'));
  assert.ok(!filenameOriginal.includes('//'));
});

test('removeVietnameseAccents converts all Vietnamese diacritics and special characters to plain ASCII', () => {
  assert.equal(
    removeVietnameseAccents('Máy hút bụi thông minh Nova & Khóa Acme D200'),
    'May hut bui thong minh Nova & Khoa Acme D200'
  );
  assert.equal(
    removeVietnameseAccents('Đèn led âm trần Đa năng'),
    'Den led am tran Da nang'
  );
  assert.equal(removeVietnameseAccents(''), '');
});

test('sanitizeFilenameInput strips accents and forbidden Windows characters while typing', () => {
  // Strips \ / : * ? " < > | and accents, but keeps normal spaces and characters
  assert.equal(
    sanitizeFilenameInput('Khóa cửa: Acme / "D200"? <Pro> *2026* | Gen 2'),
    'Khoa cua Acme  D200 Pro 2026  Gen 2'
  );
  assert.equal(
    sanitizeFilenameInput('VERITY_ROVER_Q_REVO'),
    'VERITY_ROVER_Q_REVO'
  );
  assert.equal(sanitizeFilenameInput(''), '');
});

test('getProxyFallbackUrl extracts storage key and builds same-origin proxy URL', () => {
  const { getProxyFallbackUrl } = require('./useImageExport');

  // Extracts wp-content path from custom CDN URL
  assert.equal(
    getProxyFallbackUrl('https://cdn.example.com/wp-content/uploads/2026/11/sample.webp'),
    '/api/r2-proxy?key=wp-content%2Fuploads%2F2026%2F11%2Fsample.webp'
  );

  // Extracts wp-content path with query string
  assert.equal(
    getProxyFallbackUrl('https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/sample.webp?cors=1'),
    '/api/r2-proxy?key=wp-content%2Fuploads%2F2026%2F11%2Fsample.webp'
  );

  // Extracts u/ storage path
  assert.equal(
    getProxyFallbackUrl('https://cdn.example.com/u/2026/11/sample.webp'),
    '/api/r2-proxy?key=u%2F2026%2F11%2Fsample.webp'
  );

  // Already a proxy URL returns null (no redundant proxying)
  assert.equal(getProxyFallbackUrl('/api/r2-proxy?key=test.webp'), null);
  assert.equal(getProxyFallbackUrl('https://veritydam.example.com/api/r2-proxy?key=test.webp'), null);

  // Non-storage URLs return null
  assert.equal(getProxyFallbackUrl('https://external.com/other.png'), null);
  assert.equal(getProxyFallbackUrl(''), null);
});

