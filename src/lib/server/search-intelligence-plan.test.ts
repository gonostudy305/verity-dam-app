import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildSearchPlan, QueryIntent, type EntityExtractionResult } from './search-intelligence-plan';

// Shared golden fixture -- the SAME file the Python contract test asserts against
// (backend/tests/test_search_plan_contract.py). The `shared` block (intent/confidence/
// tokens/entities) is the cross-language ground truth; `ts_only` is this serving layer's
// derived output.
const fixturePath = path.resolve(__dirname, '../../../backend/tests/fixtures/search_plan_golden.json');

interface EntitiesFixture {
  skus: string[];
  brands: string[];
  categories: string[];
  spaces: string[];
  installationContexts: string[];
  features: string[];
  protocols: string[];
}
interface Case {
  query: string;
  shared: { intent: string; confidence: number; tokens: string[]; entities: EntitiesFixture };
  ts_only: {
    semanticEligible: boolean;
    route: string;
    isMetadataOnly: boolean;
    hasSceneContext: boolean;
    softTerms: string[];
    hardConstraints: Record<string, unknown>;
    negations: Array<Record<string, unknown>>;
  };
}
interface Fixture {
  version: number;
  families: Array<{ id: number; name: string; note?: string; cases: Case[] }>;
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

/** Sort every entity array so comparison is order-independent (the fixture arrays are
 * emitted sorted by the Python authority). */
function sortedEntities(entities: EntityExtractionResult): EntitiesFixture {
  return {
    skus: [...entities.skus].sort(),
    brands: [...entities.brands].sort(),
    categories: [...entities.categories].sort(),
    spaces: [...entities.spaces].sort(),
    installationContexts: [...entities.installationContexts].sort(),
    features: [...entities.features].sort(),
    protocols: [...entities.protocols].sort(),
  };
}

for (const family of fixture.families) {
  for (const testCase of family.cases) {
    test(`golden [${family.id}] ${family.name} :: ${testCase.query}`, () => {
      const plan = buildSearchPlan(testCase.query);

      // --- shared (must equal the Python authority) ---
      assert.equal(plan.intent, testCase.shared.intent, 'intent');
      assert.equal(plan.confidence, testCase.shared.confidence, 'confidence');
      assert.deepEqual([...plan.normalizedQuery.tokens], testCase.shared.tokens, 'tokens');
      assert.deepEqual(sortedEntities(plan.entities), testCase.shared.entities, 'entities');

      // --- ts_only (serving-layer derived output) ---
      assert.equal(plan.semanticEligible, testCase.ts_only.semanticEligible, 'semanticEligible');
      assert.equal(plan.route, testCase.ts_only.route, 'route');
      assert.equal(plan.isMetadataOnly, testCase.ts_only.isMetadataOnly, 'isMetadataOnly');
      assert.equal(plan.hasSceneContext, testCase.ts_only.hasSceneContext, 'hasSceneContext');
      assert.deepEqual(plan.softTerms, testCase.ts_only.softTerms, 'softTerms');
      assert.deepEqual(plan.hardConstraints, testCase.ts_only.hardConstraints, 'hardConstraints');
      assert.deepEqual(plan.negations, testCase.ts_only.negations, 'negations');
    });
  }
}

// --- Invariants that must hold for EVERY golden case, independent of the fixture values ---

test('semanticEligible is false exactly for exact-SKU or metadata-only queries (gating rule)', () => {
  for (const family of fixture.families) {
    for (const { query } of family.cases) {
      const plan = buildSearchPlan(query);
      const expected = !(plan.intent === QueryIntent.EXACT_SKU || plan.isMetadataOnly);
      assert.equal(plan.semanticEligible, expected, `gating for "${query}"`);
      // Exact-SKU always takes the fast path and never the semantic-eligible route.
      if (plan.intent === QueryIntent.EXACT_SKU) {
        assert.equal(plan.route, 'EXACT_FAST_PATH', `exact-sku route for "${query}"`);
        assert.equal(plan.semanticEligible, false, `exact-sku never semantic for "${query}"`);
      }
    }
  }
});

test('only whitelisted human-absence negations are hard; every other negation stays soft', () => {
  for (const family of fixture.families) {
    for (const { query } of family.cases) {
      const plan = buildSearchPlan(query);
      for (const negation of plan.negations) {
        if (negation.isHard) {
          assert.equal(negation.constraint, 'hasPeople', `hard negation must be hasPeople for "${query}"`);
          assert.equal(plan.hardConstraints.hasPeople, false, `hard negation sets hasPeople=false for "${query}"`);
        } else {
          assert.notEqual(negation.constraint, 'hasPeople', `soft negation is never hasPeople for "${query}"`);
        }
        // Provenance is always preserved.
        assert.ok(negation.matchedText.length > 0, `matchedText preserved for "${query}"`);
        assert.ok(negation.source === 'natural_language' || negation.source === 'explicit_syntax');
      }
    }
  }
});

test('buildSearchPlan is pure and deterministic (same input -> deep-equal plan)', () => {
  for (const family of fixture.families) {
    for (const { query } of family.cases) {
      assert.deepEqual(buildSearchPlan(query), buildSearchPlan(query), `determinism for "${query}"`);
    }
  }
});

test('a metadata-only plan carries no hard SKU and is routed to BASELINE_L0', () => {
  // "Acme M100": brand+model, short, no scene -> metadata-only -> not semantic-eligible.
  const plan = buildSearchPlan('Acme M100');
  assert.equal(plan.isMetadataOnly, true);
  assert.equal(plan.semanticEligible, false);
  assert.equal(plan.route, 'BASELINE_L0');
  assert.equal(plan.hardConstraints.sku, undefined);
});

test('injection-ish syntax is defanged: no hard SKU constraint is ever produced', () => {
  const plan = buildSearchPlan("sku:' or 1=1; --");
  assert.equal(plan.hardConstraints.sku, undefined);
  assert.equal(plan.intent, QueryIntent.NATURAL_LANGUAGE);
});
