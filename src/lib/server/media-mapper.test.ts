import assert from 'node:assert/strict';
import test from 'node:test';

import { mapMediaAsset, mapMediaAssetProductLink } from './media-mapper';

// Regression coverage for Batch 0 fix #1: mapOriginInfo() used to read only
// source/project_name/ticket_id/uploader from the DB row's origin_info jsonb,
// silently dropping uploader_email and batch_context even though both are
// written on upload-complete and typed on OriginInfo. DetailDrawer reads
// asset.origin_info?.uploader_email and would always see `undefined`.

test('mapMediaAsset carries uploader_email and batch_context through from origin_info', () => {
  const row = {
    id: 'asset-01',
    title: 'Ảnh test',
    media_type: 'photo',
    sku: 'AC-H03',
    brand: 'Acme',
    category: 'Studio',
    status: 'Mới',
    permission: 'public',
    origin_info: {
      source: 'Upload',
      uploader: 'demo-user',
      uploader_email: 'demo.user@example.com',
      batch_context: 'batch-2026-09-05-thao-dien',
    },
    created_at: '2026-09-05T00:00:00.000Z',
  };

  const asset = mapMediaAsset(row);

  assert.equal(asset.origin_info.uploader, 'demo-user');
  assert.equal(asset.origin_info.uploader_email, 'demo.user@example.com');
  assert.equal(asset.origin_info.batch_context, 'batch-2026-09-05-thao-dien');
});

test('mapMediaAsset omits uploader_email/batch_context rather than fabricating them when absent', () => {
  const asset = mapMediaAsset({
    id: 'asset-02',
    title: 'Ảnh AI',
    media_type: 'photo',
    sku: '',
    brand: '',
    category: '',
    status: 'Mới',
    permission: 'public',
    origin_info: { source: 'AI' },
    created_at: '2026-09-05T00:00:00.000Z',
  });

  assert.equal(asset.origin_info.uploader_email, undefined);
  assert.equal(asset.origin_info.batch_context, undefined);
});

// Batch 3: media_asset_products was previously write-only (populated by the
// DB sync triggers in 0011-0013 but never read by any application code).
// mapMediaAssetProductLink is the pure row->API-contract mapper backing
// listMediaAssetProducts (native-media.ts) and the products/[linkId] PATCH
// route -- covered here without a Postgres fixture, same as mapMediaAsset.

test('mapMediaAssetProductLink carries the joined verity_products fields and passes through a valid role/review_state', () => {
  const link = mapMediaAssetProductLink({
    id: 'link-01',
    product_id: 'product-01',
    code: 'AC-H03',
    display_name: 'Camera Acme G3',
    brand: 'Acme',
    model_name: 'G3',
    category: 'Camera',
    role: 'primary',
    confidence: 0.92,
    source: 'sku_embedding',
    review_state: 'draft',
    created_at: '2026-09-05T00:00:00.000Z',
  });

  assert.equal(link.code, 'AC-H03');
  assert.equal(link.display_name, 'Camera Acme G3');
  assert.equal(link.model_name, 'G3');
  assert.equal(link.role, 'primary');
  assert.equal(link.confidence, 0.92);
  assert.equal(link.review_state, 'draft');
});

test('mapMediaAssetProductLink defaults an unexpected role/review_state rather than throwing or fabricating primary/confirmed', () => {
  const link = mapMediaAssetProductLink({
    id: 'link-02',
    product_id: 'product-02',
    code: 'UNKNOWN-01',
    display_name: 'Unknown product',
    brand: '',
    role: 'not_a_real_role',
    confidence: null,
    source: 'catalog_import',
    review_state: 'not_a_real_state',
    created_at: '2026-09-05T00:00:00.000Z',
  });

  assert.equal(link.brand, 'unknown');
  assert.equal(link.role, 'secondary');
  assert.equal(link.review_state, 'draft');
  assert.equal(link.confidence, null);
  assert.equal(link.model_name, undefined);
  assert.equal(link.category, undefined);
});

// Batch 4: media_assets.publish_status is a real column actively written by
// backend/app/native_gateway.py (flips to 'published'/'failed' when a
// publish_wordpress ingest job completes) that no application code read
// before this -- mapMediaAsset used to drop it silently.

test('mapMediaAsset carries publish_status/published_at through for a published asset', () => {
  const asset = mapMediaAsset({
    id: 'asset-03',
    title: 'Ảnh đã xuất bản',
    media_type: 'photo',
    sku: 'AC-H03',
    brand: 'Acme',
    category: 'Studio',
    status: 'Mới',
    permission: 'public',
    publish_status: 'published',
    published_at: '2026-09-04T10:00:00.000Z',
    created_at: '2026-09-05T00:00:00.000Z',
  });

  assert.equal(asset.publish_status, 'published');
  assert.equal(asset.published_at, '2026-09-04T10:00:00.000Z');
});

test('mapMediaAsset defaults publish_status to not_requested rather than dropping the field or fabricating "published"', () => {
  const asset = mapMediaAsset({
    id: 'asset-04',
    title: 'Ảnh chưa xuất bản',
    media_type: 'photo',
    sku: '',
    brand: '',
    category: '',
    status: 'Mới',
    permission: 'public',
    created_at: '2026-09-05T00:00:00.000Z',
  });

  assert.equal(asset.publish_status, 'not_requested');
  assert.equal(asset.published_at, undefined);
});

test('mapMediaAsset exposes canonical pointer metadata without replacing the source provenance fields', () => {
  const asset = mapMediaAsset({
    id: 'asset-05',
    title: 'Ảnh canonical',
    storage_path: 'source/original.webp',
    cdn_key: 'wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp',
    cdn_url: 'https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp',
    canonical_slug: 'verity-c02',
    canonical_version: 2,
    canonical_published_version: 2,
    canonical_published_at: '2026-09-08T00:00:00.000Z',
    media_type: 'photo',
    sku: 'Verity C02', brand: 'Verity', category: 'Studio', status: 'Mới', permission: 'internal',
    created_at: '2026-09-08T00:00:00.000Z',
  }, new Map([['source/original.webp', 'https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp']]));

  assert.equal(asset.file_url, asset.cdn_url);
  assert.equal(asset.canonical_slug, 'verity-c02');
  assert.equal(asset.canonical_version, 2);
});

test('mapMediaAsset maps needs_post_production boolean column truthfully', () => {
  const flagged = mapMediaAsset({
    id: 'asset-06',
    title: 'Ảnh cần hậu kỳ',
    media_type: 'photo',
    sku: 'Verity C02',
    brand: 'Verity',
    category: 'Studio',
    status: 'Mới',
    permission: 'public',
    needs_post_production: true,
    created_at: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(flagged.needs_post_production, true);

  const unflagged = mapMediaAsset({
    id: 'asset-07',
    title: 'Ảnh chuẩn',
    media_type: 'photo',
    sku: 'Verity C02',
    brand: 'Verity',
    category: 'Studio',
    status: 'Mới',
    permission: 'public',
    needs_post_production: false,
    created_at: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(unflagged.needs_post_production, false);

  const missing = mapMediaAsset({
    id: 'asset-08',
    title: 'Ảnh legacy',
    media_type: 'photo',
    sku: '',
    brand: '',
    category: '',
    status: 'Mới',
    permission: 'public',
    created_at: '2026-09-11T00:00:00.000Z',
  });
  assert.equal(missing.needs_post_production, false);
});
