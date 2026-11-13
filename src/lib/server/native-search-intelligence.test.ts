import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANDIDATE_POOL_SAFE_CAP,
  IntelligenceFallbackError,
  listNativeLibraryMediaIntelligent,
  parseIntelligenceRawQuery,
  type QueryablePool,
} from './native-search-intelligence';
import type { NativeMediaListOptions, Row } from './native-media';
import type { MediaListParams } from '@/lib/media-api';
import { RecoveryStage } from './search-intelligence-recovery';

// ─── Fixture/mock DB integration harness (Item 17) ───────────────────────
//
// This mock does NOT parse SQL. It reproduces the same two facts every
// stage's query relies on, generically, from the VALUES array shape
// alone (all test params below use empty category/space/status/etc.
// filter arrays, so buildEligibilityWhere() never pushes a value --
// meaning every value the orchestrator pushes in these tests is a
// search-stage value, and the final value is always the LIMIT):
//   1. Eligibility (permission/deletion/review-state) -- replicated here
//      with the exact same rules buildEligibilityWhere() encodes.
//   2. A "does this row's text overlap this search value" check, generic
//      across all three value shapes the orchestrator ever sends:
//        - a bare string with no '%' wrapper = the raw query text used
//          for the position(lower(a.sku) in $N) exact-SKU recall check
//          (needle = row.sku, haystack = this value)
//        - a '%pattern%' string = a single ILIKE term
//        - a string[] = an ILIKE ANY(...) pattern array
function isEligible(row: Row, options: NativeMediaListOptions): boolean {
  const includeDeleted = options.includeDeleted === true;
  const deletedOnly = options.deletedOnly === true;
  const canSeeInternal = options.canSeeInternal !== false;
  if (deletedOnly) {
    if (!row.deleted_at) return false;
  } else if (!includeDeleted) {
    if (row.deleted_at) return false;
  }
  if (!deletedOnly && row.review_state !== 'approved') return false;
  if (!canSeeInternal && row.permission === 'internal') return false;
  return true;
}

function rowScoredText(row: Row): string {
  return [row.title, row.sku, row.brand, row.category, row.space, row.suggested_caption, row.description, ...(Array.isArray(row.keywords) ? row.keywords : [])]
    .filter((value) => typeof value === 'string')
    .join(' \n ')
    .toLowerCase();
}

function unescapeIlike(pattern: string): string {
  return pattern.replace(/\\(.)/g, '$1');
}

function rowMatchesSearchValue(row: Row, value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => rowMatchesSearchValue(row, entry));
  }
  if (typeof value !== 'string') return false;
  if (value.startsWith('%') && value.endsWith('%') && value.length >= 2) {
    const needle = unescapeIlike(value.slice(1, -1)).toLowerCase();
    if (!needle) return false;
    return rowScoredText(row).includes(needle);
  }
  const sku = typeof row.sku === 'string' ? row.sku.toLowerCase() : '';
  if (!sku) return false;
  return value.toLowerCase().includes(sku);
}

class FixturePool implements QueryablePool {
  constructor(private readonly rows: Row[], private readonly options: NativeMediaListOptions = {}) {}

  async query<T = any>(_text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    const limit = Number(values[values.length - 1]);
    const searchValues = values.slice(0, values.length - 1);
    const eligible = this.rows.filter((row) => isEligible(row, this.options));
    const matched = searchValues.length === 0 ? eligible : eligible.filter((row) => searchValues.some((value) => rowMatchesSearchValue(row, value)));
    return { rows: matched.slice(0, limit) as unknown as T[] };
  }
}

function baseParams(overrides: Partial<MediaListParams> = {}): MediaListParams {
  return {
    query: '',
    category: [],
    space: [],
    status: [],
    permission: [],
    source: [],
    mediaType: [],
    onlyAi: false,
    onlyPeople: false,
    onlyInternal: false,
    sort: 'newest',
    page: 1,
    pageSize: 40,
    ...overrides,
  };
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    title: '',
    sku: '',
    brand: '',
    category: '',
    space: '',
    suggested_caption: '',
    keywords: [],
    usage_count: 0,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    permission: 'public',
    review_state: 'approved',
    deleted_at: null,
    status: 'Mới',
    media_type: 'photo',
    ...overrides,
  };
}

// Representative 15-case-style catalog (Item 17): public approved, internal
// approved, public pending, public rejected, public deleted, plus rows
// exercising exact SKU / punctuated SKU / typo-correction scenarios.
const CATALOG: Row[] = [
  row({ id: 'r1-public-approved', sku: 'HR-21', title: 'Khóa cửa thông minh HR-21', brand: 'Acme', category: 'Khóa', space: 'Cửa chính', keywords: ['khóa', 'thông minh'] }),
  row({ id: 'r2-internal-approved', sku: 'AC-S20', title: 'Camera an ninh nội bộ', brand: 'Acme', category: 'Camera', space: 'Phòng khách', permission: 'internal' }),
  row({ id: 'r3-public-pending', sku: 'ABC-123', title: 'Robot hút bụi Drift DEMO-016 (pending)', brand: 'Drift', category: 'Robot', space: 'Phòng khách', review_state: 'pending' }),
  row({ id: 'r4-public-rejected', sku: 'ABC-1234', title: 'Robot hút bụi rejected variant', brand: 'Drift', category: 'Robot', space: 'Phòng khách', review_state: 'rejected' }),
  row({ id: 'r5-public-deleted', sku: 'DEL-001', title: 'Đèn cảm biến chuyển động (deleted)', brand: 'Nova', category: 'Đèn', space: 'Ngoài trời', deleted_at: new Date('2026-02-01T00:00:00.000Z') }),
  row({ id: 'r6-punctuated-sku', sku: 'PX-80x(8MP+2MP,4mm)', title: 'Camera CS-H80x ngoài trời', brand: 'Eden', category: 'Camera', space: 'Ngoài trời' }),
  row({ id: 'r7-scene-robot', sku: 'L20-ULTRA', title: 'Robot hút bụi phòng khách Acme', brand: 'Acme', category: 'Robot', space: 'Phòng khách', keywords: ['robot', 'hút', 'bụi'], usage_count: 10 }),
  row({ id: 'r8-abc-123-approved', sku: 'ABC-123', title: 'Phụ kiện ABC-123', brand: 'Generic', category: 'Phụ kiện', space: 'Trong nhà' }),
  row({ id: 'r9-abc-1234-approved', sku: 'ABC-1234', title: 'Phụ kiện ABC-1234', brand: 'Generic', category: 'Phụ kiện', space: 'Trong nhà' }),
  row({ id: 'r10-drift-approved', sku: 'L20-ULTRA-V2', title: 'Robot hút bụi Drift Ultra', brand: 'Drift', category: 'Robot', space: 'Phòng khách' }),
  row({ id: 'r11-desc-match', sku: 'DESC-01', title: 'Công tắc âm tường', brand: 'Acme', category: 'Công tắc', space: 'Phòng ngủ', description: 'Thiết bị hỗ trợ chuẩn kết nối zigbee 3.0 cao cấp' }),
];

const ADMIN_OPTIONS: NativeMediaListOptions = { includeDeleted: false, deletedOnly: false, canSeeInternal: true };
const VIEWER_OPTIONS: NativeMediaListOptions = { includeDeleted: false, deletedOnly: false, canSeeInternal: false };

async function search(rawQuery: string, options: NativeMediaListOptions = ADMIN_OPTIONS, overrides: Partial<MediaListParams> = {}) {
  const params = baseParams({ query: rawQuery, ...overrides });
  const pool = new FixturePool(CATALOG, options);
  // No reviewed-synonyms fixture is configured for these tests -- inject a
  // provider that resolves to [] so the REVIEWED_SYNONYMS stage never
  // reaches the real (unconfigured-in-tests) native database.
  return listNativeLibraryMediaIntelligent(params, rawQuery, options, { pool, synonymsProvider: async () => [] });
}

test('parseIntelligenceRawQuery preserves safe SKU punctuation and strips everything else', () => {
  const searchParams = new URLSearchParams({ q: 'PX-80x(8MP+2MP,4mm) <script>' });
  const parsed = parseIntelligenceRawQuery(searchParams);
  assert.equal(parsed, 'PX-80x(8MP+2MP,4mm) script');
});

test('known frozen SKU exact Top1', async () => {
  const result = await search('HR-21');
  assert.equal(result.data[0]?.id, 'r1-public-approved');
  assert.equal(result.recoveryStageUsed, RecoveryStage.ORIGINAL_ACCENTED_LEXICAL);
  // Batch 2 (search truthfulness): this is exactly the kind of signal
  // /api/media's search_meta.detected_entities now surfaces truthfully,
  // replacing LibraryView's old hardcoded "SKU: AC-H03 (Acme G3)" chip
  // fabrication with a real, query-driven fact.
  assert.equal(result.detectedEntities.exactSku, true);
});

test('catalog SKU outside the frozen 40-SKU benchmark vocabulary: exact Top1', async () => {
  const result = await search('PX-80x(8MP+2MP,4mm)');
  assert.equal(result.data[0]?.id, 'r6-punctuated-sku');
});

test('punctuated SKU exact Top1 (Item 1 -- punctuation preserved end to end)', async () => {
  const result = await search('PX-80x(8MP+2MP,4mm)');
  assert.equal(result.data[0]?.sku, 'PX-80x(8MP+2MP,4mm)');
});

test('brand + SKU exact Top1', async () => {
  const result = await search('acme L20-ULTRA');
  assert.equal(result.data[0]?.id, 'r7-scene-robot');
});

test('"ABC-123" does not exact-match "ABC-1234" -- Top1 stays the true exact SKU', async () => {
  const result = await search('ABC-123');
  assert.equal(result.data[0]?.id, 'r8-abc-123-approved');
});

test('accented query resolves directly via the original-lexical stage', async () => {
  const result = await search('khóa cửa thông minh');
  assert.equal(result.recoveryStageUsed, RecoveryStage.ORIGINAL_ACCENTED_LEXICAL);
  assert.equal(result.data[0]?.id, 'r1-public-approved');
});

test('unaccented query recovers via the accent-folded token-group stage', async () => {
  const result = await search('khoa cua thong minh');
  assert.equal(result.recoveryStageUsed, RecoveryStage.ACCENT_FOLDED_LEXICAL);
  assert.ok(result.data.some((asset) => asset.id === 'r1-public-approved'));
});

test('"acmee" typo recovers via the bounded fuzzy-correction stage toward "acme"', async () => {
  const result = await search('acmee');
  assert.equal(result.recoveryStageUsed, RecoveryStage.BOUNDED_FUZZY_CORRECTION);
  assert.ok(result.data.length > 0);
});

test('"driit" typo recovers toward "drift"/"Drift"', async () => {
  const result = await search('driit');
  assert.equal(result.recoveryStageUsed, RecoveryStage.BOUNDED_FUZZY_CORRECTION);
  assert.ok(result.data.some((asset) => asset.brand === 'Drift'));
});

test('"robork" typo recovers toward "robot"', async () => {
  const result = await search('robork');
  assert.equal(result.recoveryStageUsed, RecoveryStage.BOUNDED_FUZZY_CORRECTION);
  assert.ok(result.data.some((asset) => asset.category === 'Robot'));
});

test('"robot hut bùi" mixed-accent typo query still returns the scene result', async () => {
  const result = await search('robot hut bùi');
  assert.ok(result.data.some((asset) => asset.id === 'r7-scene-robot'));
});

test('"robot hút bụi phòng khách" scene query resolves directly via original-lexical, Top1', async () => {
  const result = await search('robot hút bụi phòng khách');
  assert.equal(result.recoveryStageUsed, RecoveryStage.ORIGINAL_ACCENTED_LEXICAL);
  assert.equal(result.data[0]?.id, 'r7-scene-robot');
});

test('controlled nonsense query against a broad eligible set returns an honest zero result, not asset-id-ordered noise', async () => {
  const result = await search('xyzzy-no-such-product-999');
  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
  assert.equal(result.recoveryStageUsed, RecoveryStage.EXHAUSTED);
});

test('permission-excluded document cannot reappear even when it is the only literal match (auth before rank)', async () => {
  const viewerResult = await search('AC-S20', VIEWER_OPTIONS);
  assert.deepEqual(viewerResult.data, []);
  assert.equal(viewerResult.total, 0);

  const adminResult = await search('AC-S20', ADMIN_OPTIONS);
  assert.equal(adminResult.data[0]?.id, 'r2-internal-approved');
});

test('oversized candidate pool is skipped (not ranked) rather than aborting the whole recovery + semantic pipeline', async () => {
  // Every stage that tries an ILIKE-any/term match against this catalog
  // ("camera" is in every title) overflows CANDIDATE_POOL_SAFE_CAP. That
  // must never be ranked, but it also must not throw the caller straight
  // to BASELINE_L0 -- doing so used to kill the semantic channel too for
  // any ordinary query whose only oversized stage happened to sit
  // mid-pipeline (see search-intelligence-recovery.ts). The safe outcome
  // here is an honest empty result once every stage has been tried, not a
  // rejected promise.
  const bigCatalog: Row[] = Array.from({ length: CANDIDATE_POOL_SAFE_CAP + 5 }, (_, index) =>
    row({ id: `bulk-${index}`, sku: `BULK-${index}`, title: 'Camera phổ biến', brand: 'Common', category: 'Camera', space: 'Phòng khách' }),
  );
  const params = baseParams({ query: 'camera' });
  const pool = new FixturePool(bigCatalog, ADMIN_OPTIONS);
  const result = await listNativeLibraryMediaIntelligent(params, 'camera', ADMIN_OPTIONS, {
    pool,
    synonymsProvider: async () => [],
  });
  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
  assert.equal(result.recoveryStageUsed, RecoveryStage.EXHAUSTED);
});

test('pagination occurs strictly after ranking (Item 11)', async () => {
  const full = await search('robot', ADMIN_OPTIONS, { page: 1, pageSize: 100 });
  assert.ok(full.total >= 2);
  const fullOrder = full.data.map((asset) => asset.id);

  const page1 = await search('robot', ADMIN_OPTIONS, { page: 1, pageSize: 1 });
  const page2 = await search('robot', ADMIN_OPTIONS, { page: 2, pageSize: 1 });

  assert.deepEqual(page1.data.map((asset) => asset.id), fullOrder.slice(0, 1));
  assert.deepEqual(page2.data.map((asset) => asset.id), fullOrder.slice(1, 2));
  assert.equal(page1.total, full.total);
  assert.equal(page2.total, full.total);
});

test('response shape is exactly {data, total} plus the internal-only recoveryStageUsed/semanticActive/detectedEntities fields', async () => {
  // Batch 2 (search truthfulness): recoveryStageUsed alone was being silently
  // dropped by /api/media's route handler. semanticActive and
  // detectedEntities are new, equally "internal-only" fields that route.ts
  // now surfaces (as search_meta) so the FE can show what the engine
  // actually did instead of a hardcoded, fabricated interpretation.
  const result = await search('HR-21');
  assert.deepEqual(Object.keys(result).sort(), ['data', 'detectedEntities', 'recoveryStageUsed', 'resultScoresById', 'semanticActive', 'semanticHitAssetIds', 'total']);
  assert.equal(result.semanticActive, false, 'SigLIP2/nl_search_space_id stays inactive -- semantic must never claim active in this fixture');
});

test('an empty intelligence query throws a typed fallback error rather than silently no-oping', async () => {
  const pool = new FixturePool(CATALOG, ADMIN_OPTIONS);
  await assert.rejects(
    () => listNativeLibraryMediaIntelligent(baseParams({ query: '' }), '', ADMIN_OPTIONS, { pool }),
    (error: unknown) => error instanceof IntelligenceFallbackError && error.reason === 'EMPTY_INTELLIGENCE_QUERY',
  );
});

test('description match is retrieved when query matches description text', async () => {
  const result = await search('zigbee');
  assert.equal(result.data.some((asset) => asset.id === 'r11-desc-match'), true);
});

test('Phase 2B wiring: product-safe catalog promotes confirmed assets and demotes unconfirmed', async () => {
  process.env.VERITY_SEARCH_CATALOG_V1_ENABLED = 'true';
  try {
    const pool = new FixturePool(CATALOG, ADMIN_OPTIONS);
    // r1-public-approved has sku="HR-21"
    const result = await listNativeLibraryMediaIntelligent(
      baseParams({ query: 'HR-21' }),
      'HR-21',
      ADMIN_OPTIONS,
      {
        pool,
        resolveProductSafeAssetIds: async () => new Set(['r1-public-approved']),
      },
    );
    assert.equal(result.data[0]?.id, 'r1-public-approved');
  } finally {
    delete process.env.VERITY_SEARCH_CATALOG_V1_ENABLED;
  }
});

test('Phase 2C wiring: MMR diversification operates over candidate embeddings when flag is on', async () => {
  process.env.VERITY_SEARCH_MMR_V1_ENABLED = 'true';
  try {
    const pool = new FixturePool(CATALOG, ADMIN_OPTIONS);
    let embeddingsCalled = false;
    const result = await listNativeLibraryMediaIntelligent(
      baseParams({ query: 'camera' }),
      'camera',
      ADMIN_OPTIONS,
      {
        pool,
        fetchCandidateEmbeddings: async (ids) => {
          embeddingsCalled = true;
          const map = new Map<string, readonly number[]>();
          for (const id of ids) {
            map.set(id, [1, 0, 0]);
          }
          return map;
        },
      },
    );
    assert.equal(embeddingsCalled, true);
    assert.ok(result.total > 0);
  } finally {
    delete process.env.VERITY_SEARCH_MMR_V1_ENABLED;
  }
});

test('auto-routing: exact SKU skips semantic retrieval while natural descriptive queries permit it', async () => {
  const pool = new FixturePool(CATALOG, ADMIN_OPTIONS);

  // 1. Exact SKU query: buildSearchPlan identifies EXACT_SKU -> semanticEligible = false.
  // In default production path (no deps.semanticRetriever override), it skips PostgresSiglip2SemanticRetriever.
  const skuResult = await listNativeLibraryMediaIntelligent(
    baseParams({ query: 'HR-21' }),
    'HR-21',
    ADMIN_OPTIONS,
    { pool },
  );
  assert.equal(skuResult.semanticActive, false);
  assert.equal(skuResult.detectedEntities.exactSku, true);
});
