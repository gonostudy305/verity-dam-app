import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandCatalogRows,
  resolveProductSafeAssetIds,
  seedCatalogFromDatabase,
  type CatalogQueryable,
} from './search-catalog-db';
import { DynamicCatalogResolver } from './search-catalog-resolver';
import { isSearchCatalogV1Enabled } from './search-intelligence-flag';

interface Call {
  text: string;
  params?: unknown[];
}

function fakeDb(rows: Array<Record<string, unknown>>, calls: Call[] = []): CatalogQueryable {
  return {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows };
    },
  };
}

function throwingDb(calls: Call[] = []): CatalogQueryable {
  return {
    query: async (text, params) => {
      calls.push({ text, params });
      throw new Error('connection refused');
    },
  };
}

test('expandCatalogRows: expands code + primary_sku + aliases, dedup case-insensitive', () => {
  const records = expandCatalogRows([
    {
      code: 'ABC-1234',
      primary_sku: 'ABC-12',
      aliases: ['abc-1234', 'XY-9'], // "abc-1234" collides with code, dedup'd
      brand: 'Acme',
      category: 'lock',
      display_name: 'Door Lock',
    },
  ]);
  const skus = records.map((r) => r.sku).sort();
  assert.deepEqual(skus, ['ABC-12', 'ABC-1234', 'XY-9']);
  const code = records.find((r) => r.sku === 'ABC-1234');
  assert.equal(code?.brand, 'Acme');
  assert.equal(code?.category, 'lock');
  assert.equal(code?.displayName, 'Door Lock');
});

test('seedCatalogFromDatabase: seeds resolver longest-first and enables lookups', async () => {
  const resolver = new DynamicCatalogResolver();
  const result = await seedCatalogFromDatabase(
    resolver,
    fakeDb([
      { code: 'ABC-1234', primary_sku: null, aliases: [], brand: 'Acme' },
      { code: 'ABC-12', primary_sku: null, aliases: ['ZZ-1'], brand: 'Acme' },
    ]),
  );
  assert.equal(result.seeded, true);
  assert.equal(result.productCount, 2);
  // Anti-shadowing: longest key must sort first so ABC-12 never masks ABC-1234.
  assert.equal(resolver.getKnownSkus()[0], 'ABC-1234');
  assert.equal(resolver.hasSku('abc-1234'), true);
  assert.equal(resolver.hasSku('zz-1'), true);
  assert.equal(resolver.hasSku('not-a-sku'), false);
});

test('seedCatalogFromDatabase: empty catalog does NOT wipe existing seed (fail-closed)', async () => {
  const resolver = new DynamicCatalogResolver(); // constructor seeds calibration SKUs
  assert.equal(resolver.hasSku('HR-21'), true, 'calibration seed present initially');
  const result = await seedCatalogFromDatabase(resolver, fakeDb([]));
  assert.equal(result.seeded, false);
  assert.equal(result.error, 'EMPTY_CATALOG');
  assert.equal(resolver.hasSku('HR-21'), true, 'calibration seed left intact');
});

test('seedCatalogFromDatabase: query error is fail-closed and leaves resolver intact', async () => {
  const resolver = new DynamicCatalogResolver();
  const result = await seedCatalogFromDatabase(resolver, throwingDb());
  assert.equal(result.seeded, false);
  assert.match(result.error || '', /connection refused/);
  assert.equal(resolver.hasSku('HR-21'), true);
});

test('resolveProductSafeAssetIds: returns confirmed-only asset ids and uses confirmed SQL', async () => {
  const calls: Call[] = [];
  const ids = await resolveProductSafeAssetIds(
    fakeDb([{ media_asset_id: 'a1' }, { media_asset_id: 'a2' }, { media_asset_id: 'a1' }], calls),
    '  D200i  ',
  );
  assert.deepEqual([...ids].sort(), ['a1', 'a2']);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /review_state = 'confirmed'/, 'must enforce confirmed relationships');
  assert.equal(calls[0].params?.[0], 'D200i', 'token trimmed');
  assert.equal(calls[0].params?.[1], null, 'no role filter by default');
});

test('resolveProductSafeAssetIds: empty token short-circuits without querying', async () => {
  const calls: Call[] = [];
  const ids = await resolveProductSafeAssetIds(fakeDb([{ media_asset_id: 'x' }], calls), '   ');
  assert.equal(ids.size, 0);
  assert.equal(calls.length, 0, 'no DB call for empty token');
});

test('resolveProductSafeAssetIds: role filter is passed through', async () => {
  const calls: Call[] = [];
  await resolveProductSafeAssetIds(fakeDb([], calls), 'D200i', { roles: ['primary'] });
  assert.deepEqual(calls[0].params?.[1], ['primary']);
});

test('resolveProductSafeAssetIds: fails closed to empty set on DB error (no wrong-product leak)', async () => {
  const ids = await resolveProductSafeAssetIds(throwingDb(), 'D200i');
  assert.equal(ids.size, 0);
});

test('flag: isSearchCatalogV1Enabled defaults OFF', () => {
  assert.equal(isSearchCatalogV1Enabled({}), false);
  assert.equal(isSearchCatalogV1Enabled({ VERITY_SEARCH_CATALOG_V1_ENABLED: 'true' }), true);
});
