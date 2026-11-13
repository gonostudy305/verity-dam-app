import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALIBRATION_SKUS,
  DynamicCatalogResolver,
  StaticCatalogResolver,
  defaultCatalogResolver,
} from './search-catalog-resolver';
import { buildSearchPlan, QueryIntent } from './search-intelligence-plan';

test('StaticCatalogResolver contains all 40 calibration SKUs', () => {
  assert.equal(CALIBRATION_SKUS.length, 40);
  const resolver = new StaticCatalogResolver();
  assert.equal(resolver.getKnownSkus().length, 40);
  assert.equal(resolver.hasSku('AC-S20'), true);
  assert.equal(resolver.hasSku('ac-s20'), true);
  assert.equal(resolver.hasSku('NON_EXISTENT_SKU'), false);

  const record = resolver.lookupSku('AC-S20');
  assert.ok(record);
  assert.equal(record.sku, 'AC-S20');
});

test('buildSearchPlan defaults to calibration SKUs when no resolver provided', () => {
  const plan = buildSearchPlan('AC-S20');
  assert.equal(plan.intent, QueryIntent.EXACT_SKU);
  assert.equal(plan.hardConstraints.sku, 'AC-S20');
  assert.equal(plan.semanticEligible, false);
});

test('buildSearchPlan recognizes dynamically injected live SKUs', () => {
  const dynamicResolver = new DynamicCatalogResolver();
  dynamicResolver.setSkus([
    { sku: 'LIVE-CAMERA-4K-PRO', brand: 'EDEN', category: 'Product_Line_B' },
    { sku: 'CUSTOM-SMART-LOCK-V3', brand: 'Acme', category: 'Product_Line_A' },
  ]);

  // Query containing newly injected SKU
  const plan1 = buildSearchPlan('tìm LIVE-CAMERA-4K-PRO chính hãng', {
    catalogResolver: dynamicResolver,
  });
  assert.equal(plan1.intent, QueryIntent.EXACT_SKU);
  assert.equal(plan1.hardConstraints.sku, 'LIVE-CAMERA-4K-PRO');
  assert.equal(plan1.semanticEligible, false);

  // Unregistered SKU goes to normal parsing (NOT exact SKU)
  const plan2 = buildSearchPlan('tìm UNREGISTERED-MODEL-XYZ', {
    catalogResolver: dynamicResolver,
  });
  assert.notEqual(plan2.intent, QueryIntent.EXACT_SKU);
  assert.equal(plan2.hardConstraints.sku, undefined);
});

test('DynamicCatalogResolver cache freshness and staleness', () => {
  const resolver = new DynamicCatalogResolver(50); // 50ms TTL
  assert.equal(resolver.isStale(), false);
  // Sleep 60ms to verify TTL expiration
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.equal(resolver.isStale(), true);
      resolve();
    }, 60);
  });
});
