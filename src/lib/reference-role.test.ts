import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shouldPromoteToReferenceCorpus, resolveSkuContext } from './sku-context';
import { resolveReferenceRole } from './reference-role';

interface FixtureItem {
  description: string;
  input: {
    context: 'product' | 'scene' | 'marketing';
    category: string;
    hasPeople: boolean;
    skuConfidence: number | null;
    explicitOptIn: boolean;
    hasActiveReferenceForSku: boolean;
    productLinkCount: number;
  };
  expected: {
    isPromoted: boolean;
    role: string;
    curationStatus: string;
    matchEligible: boolean;
  };
}

test('reference promotion gate and role resolution matches shared fixture', () => {
  const fixturePath = join(__dirname, '../../backend/tests/fixtures/reference_gate_vectors.json');
  const fixtureData: FixtureItem[] = JSON.parse(readFileSync(fixturePath, 'utf8'));

  for (const item of fixtureData) {
    const isPromoted = shouldPromoteToReferenceCorpus({
      context: item.input.context,
      hasPeople: item.input.hasPeople,
      skuConfidence: item.input.skuConfidence,
      explicitOptIn: item.input.explicitOptIn,
    });

    assert.equal(
      isPromoted,
      item.expected.isPromoted,
      `[${item.description}] isPromoted mismatch`
    );

    const decision = resolveReferenceRole({
      isPromoted,
      hasActiveReferenceForSku: item.input.hasActiveReferenceForSku,
      category: item.input.category,
      productLinkCount: item.input.productLinkCount,
    });

    assert.equal(
      decision.role,
      item.expected.role,
      `[${item.description}] role mismatch`
    );
    assert.equal(
      decision.curationStatus,
      item.expected.curationStatus,
      `[${item.description}] curationStatus mismatch`
    );
    assert.equal(
      decision.matchEligible,
      item.expected.matchEligible,
      `[${item.description}] matchEligible mismatch`
    );
  }
});
