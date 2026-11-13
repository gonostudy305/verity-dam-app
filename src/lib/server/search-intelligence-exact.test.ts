import assert from 'node:assert/strict';
import test from 'node:test';

import { anyExact, computeExactSignals, rankTier, RankTier, type SearchDocumentLite } from './search-intelligence-exact';
import { normalizeQuery } from './search-intelligence-vn';

function doc(overrides: Partial<SearchDocumentLite> = {}): SearchDocumentLite {
  return {
    assetId: 'asset-1',
    title: '',
    sku: '',
    brand: '',
    category: '',
    space: '',
    suggestedCaption: '',
    keywords: [],
    usageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Gap A: known frozen-vocabulary-shaped SKU is an exact Top1 (TIER_0)', () => {
  const document = doc({ sku: 'HR-21' });
  const normalized = normalizeQuery('HR-21');
  const signals = computeExactSignals(document, normalized);
  assert.equal(signals.exactSku, true);
  assert.equal(rankTier(signals), RankTier.TIER_0_EXACT_SKU);
});

test('Gap A: catalog SKU OUTSIDE the frozen 40-SKU benchmark vocabulary still gets exact TIER_0', () => {
  // "ZZQ-999-NOT-IN-BENCHMARK" is not part of any frozen vocabulary --
  // production Tier-0 must work for ANY real catalog SKU.
  const document = doc({ sku: 'ZZQ-999-NOT-IN-BENCHMARK' });
  const normalized = normalizeQuery('ZZQ-999-NOT-IN-BENCHMARK');
  const signals = computeExactSignals(document, normalized);
  assert.equal(signals.exactSku, true);
  assert.equal(rankTier(signals), RankTier.TIER_0_EXACT_SKU);
});

test('Gap A: punctuated SKU is an exact Top1', () => {
  const document = doc({ sku: 'PX-80x(8MP+2MP,4mm)' });
  const normalized = normalizeQuery('PX-80x(8MP+2MP,4mm)');
  const signals = computeExactSignals(document, normalized);
  assert.equal(signals.exactSku, true);

  const document2 = doc({ sku: 'DEMO-002' });
  const normalized2 = normalizeQuery('DEMO-002');
  assert.equal(computeExactSignals(document2, normalized2).exactSku, true);
});

test('Gap A: brand-prefixed query still recognizes the exact SKU span (brand + SKU exact Top1)', () => {
  const document = doc({ sku: 'ABC-123', brand: 'acme' });
  const normalized = normalizeQuery('acme ABC-123');
  const signals = computeExactSignals(document, normalized);
  assert.equal(signals.exactSku, true);
  assert.equal(signals.exactBrand, true);
  assert.equal(signals.exactBrandModel, true);
  assert.equal(rankTier(signals), RankTier.TIER_0_EXACT_SKU);
});

test('Gap A: "ABC-123" does not exact-match "ABC-1234" in either direction', () => {
  const documentShort = doc({ sku: 'ABC-123' });
  const queryLong = normalizeQuery('ABC-1234');
  assert.equal(computeExactSignals(documentShort, queryLong).exactSku, false);

  const documentLong = doc({ sku: 'ABC-1234' });
  const queryShort = normalizeQuery('ABC-123');
  assert.equal(computeExactSignals(documentLong, queryShort).exactSku, false);
});

test('anyExact is true only when at least one signal is true', () => {
  const noSignals = { exactSku: false, exactBrandModel: false, exactTitlePhrase: false, exactBrand: false };
  assert.equal(anyExact(noSignals), false);
  assert.equal(anyExact({ ...noSignals, exactBrand: true }), true);
});
