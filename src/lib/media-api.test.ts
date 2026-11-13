import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areCompatibleMimeTypes,
  createStorageFileName,
  normalizeMimeType,
  parseMediaListParams,
  parseReviewDecision,
  restrictReviewPatchToFields,
  sanitizeReviewPatch,
  sanitizeReviewPatchFields,
  sanitizeReviewCorrections,
  sanitizeReviewNonCatalog,
  sanitizeReviewPromoteReference,
  sanitizeReviewProductLinks,
  sanitizeReviewNeedsPostProduction,
  isUuid,
  validateUploadCandidate,
  ValidationError,
} from './media-api';
import {
  getDemoMediaAsset,
  listDemoLibraryMedia,
  listDemoReviewItems,
  resolveDemoReviewItem,
} from './server/demo-media';
// ─── Local dev mode helpers (pure functions) ─────────────────────────────────
// They belong here because they are only tested, never called in production.

function assertNoConflictingLocalModes(
  nodeEnvironment: string | undefined,
  demoMode: string | undefined,
  realDataMode: string | undefined,
) {
  if (nodeEnvironment === 'development' && demoMode === 'true' && realDataMode === 'true') {
    throw new Error('VERITY_MEDIA_DEMO_MODE and VERITY_MEDIA_REAL_DATA_DEV_MODE cannot both be enabled.');
  }
}

function isLocalDemoMode(
  nodeEnvironment = process.env.NODE_ENV,
  demoMode = process.env.VERITY_MEDIA_DEMO_MODE,
  realDataMode = process.env.VERITY_MEDIA_REAL_DATA_DEV_MODE,
) {
  assertNoConflictingLocalModes(nodeEnvironment, demoMode, realDataMode);
  return nodeEnvironment === 'development' && demoMode === 'true';
}

function isLocalRealDataMode(
  nodeEnvironment = process.env.NODE_ENV,
  realDataMode = process.env.VERITY_MEDIA_REAL_DATA_DEV_MODE,
  loopbackLaunch = false,
  demoMode = process.env.VERITY_MEDIA_DEMO_MODE,
) {
  assertNoConflictingLocalModes(nodeEnvironment, demoMode, realDataMode);
  return nodeEnvironment === 'development' && realDataMode === 'true' && loopbackLaunch;
}
// ─────────────────────────────────────────────────────────────────────────────
import { requireWordPressSyncToken } from './server/wordpress';

test('validates a supported image upload and creates a safe storage name', () => {
  const upload = validateUploadCandidate({
    name: 'Ảnh công trình Thảo Điền 01.JPG',
    size: 1_024,
    type: 'image/jpeg',
  });

  assert.deepEqual(upload, {
    fileName: 'Ảnh công trình Thảo Điền 01.JPG',
    sizeBytes: 1_024,
    mimeType: 'image/jpeg',
    mediaType: 'photo',
  });
  assert.equal(createStorageFileName(upload.fileName), 'Anh-cong-trinh-Thao-ien-01.jpg');
});

test('validates HEIC/HEIF images and handles empty MIME with filename fallback', () => {
  const uploadExplicit = validateUploadCandidate({
    name: 'IMG_4821.HEIC',
    size: 2_500_000,
    type: 'image/heic',
  });
  assert.equal(uploadExplicit.mediaType, 'photo');
  assert.equal(uploadExplicit.mimeType, 'image/heic');

  const uploadFallback = validateUploadCandidate({
    name: 'IMG_9999.heic',
    size: 3_000_000,
    type: '',
  });
  assert.equal(uploadFallback.mediaType, 'photo');
  assert.equal(uploadFallback.mimeType, 'image/heic');
});

test('normalizes and validates compatible MIME types across platforms', () => {
  assert.equal(normalizeMimeType('image/jpeg; charset=utf-8'), 'image/jpeg');
  assert.equal(normalizeMimeType('  VIDEO/MP4; codecs="avc1"  '), 'video/mp4');
  assert.equal(normalizeMimeType(''), '');

  // Exact match
  assert.equal(areCompatibleMimeTypes('image/jpeg', 'image/jpeg'), true);
  assert.equal(areCompatibleMimeTypes('image/jpeg; charset=utf-8', 'image/jpeg'), true);

  // HEIC and HEIF cross-platform equivalence
  assert.equal(areCompatibleMimeTypes('image/heic', 'image/heif'), true);
  assert.equal(areCompatibleMimeTypes('image/heif', 'image/heic'), true);
  assert.equal(areCompatibleMimeTypes('image/heic; charset=utf-8', 'image/heif'), true);

  // Video MP4 and QuickTime MOV cross-platform equivalence
  assert.equal(areCompatibleMimeTypes('video/mp4', 'video/quicktime'), true);
  assert.equal(areCompatibleMimeTypes('video/quicktime', 'video/mp4'), true);

  // Incompatible types
  assert.equal(areCompatibleMimeTypes('image/png', 'image/jpeg'), false);
  assert.equal(areCompatibleMimeTypes('image/heic', 'video/mp4'), false);
  assert.equal(areCompatibleMimeTypes('', 'image/jpeg'), false);
});

test('rejects unsupported MIME types and invalid sizes', () => {
  assert.throws(
    () => validateUploadCandidate({ name: 'payload.svg', size: 100, type: 'image/svg+xml' }),
    ValidationError
  );
  assert.throws(
    () => validateUploadCandidate({ name: 'large.mp4', size: 201 * 1024 * 1024, type: 'video/mp4' }),
    ValidationError
  );
});

test('parses list filters while removing query control characters from search', () => {
  const params = parseMediaListParams(new URLSearchParams(
    'q=G3,foo)%20or%20true&category=Công%20trình&category=Studio&only_ai=true&sort=most_used&page=2&page_size=500'
  ));

  assert.equal(params.query, 'G3 foo or true');
  assert.deepEqual(params.category, ['Công trình', 'Studio']);
  assert.equal(params.onlyAi, true);
  assert.equal(params.sort, 'most_used');
  assert.equal(params.page, 2);
  assert.equal(params.pageSize, 100);
});

test('accepts only approved/rejected decisions and a bounded allowlist patch', () => {
  assert.equal(parseReviewDecision('approved'), 'approved');
  // Batch 1a: 'skipped' ("để sau") is a real, persisted review_queue.status
  // value (see backend/migrations/0003_native_media_schema.sql), not a
  // rejected decision -- it must parse, not throw.
  assert.equal(parseReviewDecision('skipped'), 'skipped');
  assert.throws(() => parseReviewDecision('archived'), ValidationError);
  assert.deepEqual(
    sanitizeReviewPatch({
      sku: ' AC-H03 ',
      permission: 'internal',
      unexpected: 'discarded',
      suggested_caption: 42,
      author: ' VerityDAM Platform ',
      copyright: ' © 2026 Verity ',
      credit: ' Team Media ',
      description: ' Ảnh chụp thực tế ',
      keywords: [' acme ', 'camera ', ''],
    }),
    {
      sku: 'AC-H03',
      permission: 'internal',
      author: 'VerityDAM Platform',
      copyright: '© 2026 Verity',
      credit: 'Team Media',
      description: 'Ảnh chụp thực tế',
      keywords: ['acme', 'camera'],
    }
  );
  assert.deepEqual(
    sanitizeReviewPatch({
      keywords: 'home appliance, zigbee, acme',
    }),
    {
      keywords: ['home appliance', 'zigbee', 'acme'],
    }
  );
});

test('batch patch_fields is optional, validated, and authoritatively filters patch and corrections', () => {
  const legacyPatch = { brand: 'Verity', description: 'Giữ nguyên đường cũ' };
  assert.deepEqual(restrictReviewPatchToFields(legacyPatch, sanitizeReviewPatchFields(undefined)), legacyPatch);

  const fields = sanitizeReviewPatchFields(['brand', 'description', 'nope', 42]);
  assert.deepEqual([...fields || []].sort(), ['brand', 'description']);
  assert.deepEqual(
    restrictReviewPatchToFields({ brand: 'Verity', description: 'Mô tả', sku: 'A1' }, fields),
    { brand: 'Verity', description: 'Mô tả' }
  );
  assert.deepEqual(
    restrictReviewPatchToFields(sanitizeReviewCorrections(['brand', 'sku']), fields),
    { brand: true }
  );
});

test('accepts only canonical UUIDs used by media routes', () => {
  assert.equal(isUuid('e1a0b1c2-0001-4000-8000-000000000001'), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid('r1a0b1c2-0001-4000-8000-000000000001'), false);
});

test('serves the prototype library through the same filtered API contract in demo mode', () => {
  const result = listDemoLibraryMedia({
    query: 'lumos',
    category: ['Studio'],
    space: [],
    status: [],
    permission: [],
    source: [],
    mediaType: [],
    onlyAi: true,
    onlyPeople: false,
    onlyInternal: false,
    sort: 'newest',
    page: 1,
    pageSize: 100,
  });

  assert.equal(result.total, 1);
  assert.equal(result.data[0]?.id, 'asset-03');
  assert.equal(getDemoMediaAsset('asset-03')?.brand, 'Lumos');
  assert.equal(listDemoReviewItems().length, 5);
});

test('resolves a demo review item and exposes an approved asset to the library', () => {
  const result = resolveDemoReviewItem('rq-01', 'approved', { sku: 'AC-H03-UPDATED' });

  assert.deepEqual(result, { id: 'rq-01', status: 'approved' });
  assert.equal(listDemoReviewItems().length, 4);
  assert.equal(getDemoMediaAsset('queue-asset-01')?.sku, 'AC-H03-UPDATED');
});

test('only enables the demo adapter with explicit development configuration', () => {
  assert.equal(isLocalDemoMode('development', 'true'), true);
  assert.equal(isLocalDemoMode('development', 'false'), false);
  assert.equal(isLocalDemoMode('production', 'true'), false);
  assert.equal(isLocalDemoMode('test', 'true'), false);
});

test('only enables real-data dev mode with an explicit local flag and loopback marker', () => {
  assert.equal(isLocalRealDataMode('development', 'true', true), true);
  assert.equal(isLocalRealDataMode('development', 'true', false), false);
  assert.equal(isLocalRealDataMode('development', 'false', true), false);
  assert.equal(isLocalRealDataMode('production', 'true', true), false);
  assert.equal(isLocalRealDataMode('test', 'true', true), false);
  assert.throws(() => isLocalDemoMode('development', 'true', 'true'));
});

test('requires a strong constant-time WordPress sync token', () => {
  const previous = process.env.VERITY_WORDPRESS_SYNC_TOKEN;
  process.env.VERITY_WORDPRESS_SYNC_TOKEN = 'a-secure-wordpress-token-that-is-at-least-32-chars';
  try {
    assert.doesNotThrow(() => requireWordPressSyncToken('Bearer a-secure-wordpress-token-that-is-at-least-32-chars'));
    assert.throws(() => requireWordPressSyncToken('Bearer wrong-token'));
    assert.throws(() => requireWordPressSyncToken(null));
  } finally {
    if (previous === undefined) delete process.env.VERITY_WORDPRESS_SYNC_TOKEN;
    else process.env.VERITY_WORDPRESS_SYNC_TOKEN = previous;
  }
});

test('keeps explicit reviewer corrections separate from the full prefilled patch', () => {
  assert.deepEqual(sanitizeReviewCorrections(['sku', 'suggested_caption', 'author', 'keywords', 'unknown', 42]), {
    sku: true,
    suggested_caption: true,
    author: true,
    keywords: true,
  });
  assert.deepEqual(sanitizeReviewCorrections({ sku: true }), {});
});

test('drops the stale "caption" correction key so only "suggested_caption" reaches the learning log', () => {
  // Regression guard for Batch 0 fix #2: MetadataForm used to call
  // recordEdit('caption') on the caption textarea, but the whitelisted patch
  // key (and the correction_log/few-shot field) is 'suggested_caption'. If a
  // stale 'caption' key ever reappears, this proves it is still silently
  // dropped rather than reaching review_correction_log/metadata_few_shot_examples.
  assert.deepEqual(sanitizeReviewCorrections(['caption', 'suggested_caption']), {
    suggested_caption: true,
  });
});

test('sanitizeReviewNonCatalog strictly coerces boolean true and rejects everything else', () => {
  assert.equal(sanitizeReviewNonCatalog(true), true);
  assert.equal(sanitizeReviewNonCatalog(false), false);
  assert.equal(sanitizeReviewNonCatalog('true'), false);
  assert.equal(sanitizeReviewNonCatalog('false'), false);
  assert.equal(sanitizeReviewNonCatalog(1), false);
  assert.equal(sanitizeReviewNonCatalog(0), false);
  assert.equal(sanitizeReviewNonCatalog(null), false);
  assert.equal(sanitizeReviewNonCatalog(undefined), false);
  assert.equal(sanitizeReviewNonCatalog({}), false);
});

test('sanitizeReviewPromoteReference strictly coerces boolean true and rejects everything else', () => {
  assert.equal(sanitizeReviewPromoteReference(true), true);
  assert.equal(sanitizeReviewPromoteReference(false), false);
  assert.equal(sanitizeReviewPromoteReference('true'), false);
  assert.equal(sanitizeReviewPromoteReference('false'), false);
  assert.equal(sanitizeReviewPromoteReference(1), false);
  assert.equal(sanitizeReviewPromoteReference(0), false);
  assert.equal(sanitizeReviewPromoteReference(null), false);
  assert.equal(sanitizeReviewPromoteReference(undefined), false);
  assert.equal(sanitizeReviewPromoteReference({}), false);
});

test('sanitizeReviewProductLinks sanitizes, dedupes, caps, and validates product links', () => {
  // Non-array returns empty
  assert.deepEqual(sanitizeReviewProductLinks(null), []);
  assert.deepEqual(sanitizeReviewProductLinks(undefined), []);
  assert.deepEqual(sanitizeReviewProductLinks('not-an-array'), []);
  assert.deepEqual(sanitizeReviewProductLinks({ sku: 'ABC' }), []);

  // Valid inputs with trim and case-insensitive deduplication
  const input = [
    { sku: '  Verity-001  ', role: 'secondary' },
    { sku: 'verity-001', role: 'background' }, // duplicate, should be dropped
    { sku: 'Verity-002', role: 'background' },
    { sku: 'Verity-003', role: 'packaging' },
    { sku: 'Verity-004' }, // default to secondary
    { sku: 'Verity-005', role: 'primary' }, // primary rejected
    { sku: 'Verity-006', role: 'invalid_role' }, // invalid role rejected
    { sku: '', role: 'secondary' }, // empty sku dropped
    { sku: '   ', role: 'secondary' }, // whitespace sku dropped
    null,
    123,
    { not_a_sku: 'XYZ' },
  ];

  const expected = [
    { sku: 'Verity-001', role: 'secondary' },
    { sku: 'Verity-002', role: 'background' },
    { sku: 'Verity-003', role: 'packaging' },
    { sku: 'Verity-004', role: 'secondary' },
  ];
  assert.deepEqual(sanitizeReviewProductLinks(input), expected);

  // Capped at 12 items
  const many = Array.from({ length: 20 }, (_, i) => ({
    sku: `SKU-${i}`,
    role: 'secondary' as const,
  }));
  const capped = sanitizeReviewProductLinks(many);
  assert.equal(capped.length, 12);
  assert.equal(capped[0].sku, 'SKU-0');
  assert.equal(capped[11].sku, 'SKU-11');
});

test('parseMediaListParams parses only_needs_post_production flag correctly', () => {
  const paramsTrue = parseMediaListParams(new URLSearchParams('only_needs_post_production=true'));
  assert.equal(paramsTrue.onlyNeedsPostProduction, true);

  const paramsFalse = parseMediaListParams(new URLSearchParams('only_needs_post_production=false'));
  assert.equal(paramsFalse.onlyNeedsPostProduction, false);

  const paramsAbsent = parseMediaListParams(new URLSearchParams(''));
  assert.equal(paramsAbsent.onlyNeedsPostProduction, false);
});

test('sanitizeReviewNeedsPostProduction returns boolean or undefined', () => {
  assert.equal(sanitizeReviewNeedsPostProduction(true), true);
  assert.equal(sanitizeReviewNeedsPostProduction(false), false);
  assert.equal(sanitizeReviewNeedsPostProduction('true'), undefined);
  assert.equal(sanitizeReviewNeedsPostProduction(null), undefined);
  assert.equal(sanitizeReviewNeedsPostProduction(undefined), undefined);
  assert.equal(sanitizeReviewNeedsPostProduction(1), undefined);
});

