import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import type { MediaAsset } from '@/types/media';
import { formatMediaSearchResultUrls } from '@/lib/server/media-search-result-urls';
import { POST, GET } from './route';

const TEST_SERVICE_KEY = 'test-internal-service-key-12345';

const BASE_ASSET = {
  id: '43a5a39e-7567-4103-a1ba-c602d76e361b',
  title: 'EDEN DEMO-007 Public Banner',
  file_url: 'https://dam.verity.internal/api/r2-proxy?key=media/eden-dl05.webp',
  thumbnail_url: 'https://dam.verity.internal/api/r2-proxy?key=thumb/eden-dl05.webp',
  permission: 'public',
  status: 'approved',
  dimensions: { width: 1200, height: 800 },
} as MediaAsset;

function formatOne(overrides: Partial<MediaAsset> = {}) {
  return formatMediaSearchResultUrls({ ...BASE_ASSET, ...overrides } as MediaAsset);
}

test('media-search exposes only a version-matched WordPress rendition as cdn_url', () => {
  const result = formatOne({
    cdn_key: 'wp-content/uploads/2026/09/eden-demo-007-public-banner.webp',
    cdn_url: 'https://assets.verity.internal/wp-content/uploads/2026/09/eden-demo-007-public-banner.webp',
    canonical_version: 3,
    canonical_published_version: 3,
  });

  assert.equal(result.cdn_url, 'https://assets.verity.internal/wp-content/uploads/2026/09/eden-demo-007-public-banner.webp');
  assert.equal(result.file_url, result.cdn_url);
  assert.equal(result.thumbnail_url, result.cdn_url);
  assert.equal(result.width, 1200);
  assert.equal(result.height, 800);
});

test('media-search keeps fallback URLs separate when canonical rendition is stale or absent', () => {
  const result = formatOne({
    cdn_key: 'wp-content/uploads/2026/09/stale.webp',
    cdn_url: 'https://assets.verity.internal/wp-content/uploads/2026/09/stale.webp',
    canonical_version: 4,
    canonical_published_version: 3,
  });

  assert.equal(result.cdn_url, null);
  assert.equal(result.file_url, BASE_ASSET.file_url);
  assert.equal(result.thumbnail_url, BASE_ASSET.thumbnail_url);
});

test('media-search rejects non-WordPress or insecure CDN URLs as canonical', () => {
  const result = formatOne({
    cdn_key: 'other-prefix/asset.webp',
    cdn_url: 'http://assets.verity.internal/wp-content/uploads/2026/09/asset.webp',
    canonical_version: 1,
    canonical_published_version: 1,
  });

  assert.equal(result.cdn_url, null);
  assert.equal(result.file_url, BASE_ASSET.file_url);
});

test('media-search returns null dimensions unless both are positive finite integers', () => {
  const result = formatOne({
    dimensions: { width: '1200px', height: -800 } as unknown as MediaAsset['dimensions'],
  });

  assert.equal(result.width, null);
  assert.equal(result.height, null);

  const nonIntegerResult = formatOne({
    dimensions: { width: 1200.5, height: Infinity } as unknown as MediaAsset['dimensions'],
  });
  assert.equal(nonIntegerResult.width, null);
  assert.equal(nonIntegerResult.height, null);
});

test('internal media-search fails closed (500) if service key is unconfigured on server', async () => {
  const origKey = process.env.VERITY_INTERNAL_SERVICE_KEY;
  delete process.env.VERITY_INTERNAL_SERVICE_KEY;
  try {
    const req = new NextRequest('http://localhost:3000/api/internal/media-search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-service-key': 'any-key' },
      body: JSON.stringify({ query: 'test' }),
    });
    const res = await POST(req);
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.error.code, 'SERVICE_KEY_UNCONFIGURED');
  } finally {
    process.env.VERITY_INTERNAL_SERVICE_KEY = origKey;
  }
});

test('internal media-search rejects request without service key', async () => {
  process.env.VERITY_INTERNAL_SERVICE_KEY = TEST_SERVICE_KEY;
  const req = new NextRequest('http://localhost:3000/api/internal/media-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test' }),
  });
  const res = await POST(req);
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error.code, 'UNAUTHORIZED_INTERNAL_SERVICE');
});

test('internal media-search rejects wrong service key', async () => {
  process.env.VERITY_INTERNAL_SERVICE_KEY = TEST_SERVICE_KEY;
  const req = new NextRequest('http://localhost:3000/api/internal/media-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-service-key': 'wrong-key-12345',
    },
    body: JSON.stringify({ query: 'test' }),
  });
  const res = await POST(req);
  assert.equal(res.status, 401);
});

test('internal media-search rejects request without actor user id', async () => {
  process.env.VERITY_INTERNAL_SERVICE_KEY = TEST_SERVICE_KEY;
  const req = new NextRequest('http://localhost:3000/api/internal/media-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-service-key': TEST_SERVICE_KEY,
    },
    body: JSON.stringify({ query: 'test' }),
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'ACTOR_USER_ID_REQUIRED');
});
