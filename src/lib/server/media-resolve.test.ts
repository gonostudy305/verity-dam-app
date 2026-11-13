import assert from 'node:assert/strict';
import test from 'node:test';
import { findMediaAssetIdByUrlOrPath } from './native-media';

test('findMediaAssetIdByUrlOrPath: returns UUID directly when valid UUID is passed', async () => {
  const validUuid = '11111111-1111-4111-8111-111111111111';
  const result = await findMediaAssetIdByUrlOrPath(validUuid);
  assert.equal(result, validUuid);
});

test('findMediaAssetIdByUrlOrPath: returns null on empty or whitespace string', async () => {
  const result1 = await findMediaAssetIdByUrlOrPath('');
  assert.equal(result1, null);

  const result2 = await findMediaAssetIdByUrlOrPath('   ');
  assert.equal(result2, null);
});

test('findMediaAssetIdByUrlOrPath: extracts components correctly from WordPress rendition URL', async () => {
  const targetUrl = 'https://assets.verity.internal/wp-content/uploads/2026/09/verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien-04365279a52dee9f-1600x900.webp?v=1';
  const expectedAssetId = '22222222-2222-4222-8222-222222222222';

  let capturedQuery = '';
  let capturedParams: any[] = [];

  const mockPool = {
    query: async (queryText: string, params: any[]) => {
      capturedQuery = queryText;
      capturedParams = params;
      return { rows: [{ media_asset_id: expectedAssetId }] };
    },
  };

  const result = await findMediaAssetIdByUrlOrPath(targetUrl, mockPool);
  assert.equal(result, expectedAssetId);

  // $1: full URL without query params
  assert.equal(
    capturedParams[0],
    'https://assets.verity.internal/wp-content/uploads/2026/09/verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien-04365279a52dee9f-1600x900.webp'
  );
  // $2: clean relative path
  assert.equal(
    capturedParams[1],
    'wp-content/uploads/2026/09/verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien-04365279a52dee9f-1600x900.webp'
  );
  // $4: extracted canonical slug (without hash and dimension suffix)
  assert.equal(
    capturedParams[3],
    'verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien'
  );
  // $6: extracted 16-hex hash
  assert.equal(capturedParams[5], '04365279a52dee9f');
  // $7: filename
  assert.equal(
    capturedParams[6],
    'verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien-04365279a52dee9f-1600x900.webp'
  );
});

test('findMediaAssetIdByUrlOrPath: handles R2 Cloudflare URLs correctly', async () => {
  const r2Url = 'https://pub-84ff0d046f8d4847b311746ad20e50fc.r2.dev/media/canonical/verity-sl108-test.webp';
  const expectedAssetId = '33333333-3333-4333-8333-333333333333';

  let capturedParams: any[] = [];
  const mockPool = {
    query: async (_queryText: string, params: any[]) => {
      capturedParams = params;
      return { rows: [{ media_asset_id: expectedAssetId }] };
    },
  };

  const result = await findMediaAssetIdByUrlOrPath(r2Url, mockPool);
  assert.equal(result, expectedAssetId);
  assert.equal(capturedParams[0], r2Url);
  assert.equal(capturedParams[1], 'media/canonical/verity-sl108-test.webp');
  assert.equal(capturedParams[3], 'verity-sl108-test');
});

test('findMediaAssetIdByUrlOrPath: handles pure canonical slug lookup', async () => {
  const slug = 'verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien';
  const expectedAssetId = '44444444-4444-4444-8444-444444444444';

  let capturedParams: any[] = [];
  const mockPool = {
    query: async (_queryText: string, params: any[]) => {
      capturedParams = params;
      return { rows: [{ media_asset_id: expectedAssetId }] };
    },
  };

  const result = await findMediaAssetIdByUrlOrPath(slug, mockPool);
  assert.equal(result, expectedAssetId);
  assert.equal(capturedParams[3], slug);
});
