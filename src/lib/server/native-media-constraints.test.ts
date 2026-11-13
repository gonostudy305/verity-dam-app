import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEligibilityWhere, deriveSearchConstraints } from './native-media';
import { isProductIntakesEnabled } from './product-intakes';
import type { MediaListParams } from '@/lib/media-api';

// Phase 1B (#44): wiring of the deterministic query-derived HARD constraint
// (hasPeople=false) into the BASELINE_L0 eligibility predicate. These are pure
// SQL/constraint-builder tests -- no database, no network.

const FLAG_ON = { VERITY_SEARCH_CONSTRAINTS_V1_ENABLED: 'true' } as const;
const FLAG_OFF = { VERITY_SEARCH_CONSTRAINTS_V1_ENABLED: 'false' } as const;

const HAS_PEOPLE_TRUE = `coalesce((a.ai_flags->>'has_people')::boolean, false)`;
const HAS_PEOPLE_FALSE = `coalesce((a.ai_flags->>'has_people')::boolean, false) = false`;

test('product intake rollout is disabled unless explicitly set to true', () => {
  assert.equal(isProductIntakesEnabled({}), false);
  assert.equal(isProductIntakesEnabled({ VERITY_PRODUCT_INTAKES_ENABLED: 'false' }), false);
  assert.equal(isProductIntakesEnabled({ VERITY_PRODUCT_INTAKES_ENABLED: 'TRUE' }), false);
  assert.equal(isProductIntakesEnabled({ VERITY_PRODUCT_INTAKES_ENABLED: 'true' }), true);
});

function mkParams(overrides: Partial<MediaListParams> = {}): MediaListParams {
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
    pageSize: 24,
    ...overrides,
  };
}

// --- deriveSearchConstraints: flag gating + whitelist projection ---

test('flag OFF: no constraint derived even for an explicit human-absence query', () => {
  assert.equal(deriveSearchConstraints('khóa thông minh không có người', FLAG_OFF), undefined);
  assert.equal(deriveSearchConstraints('không có người', FLAG_OFF), undefined);
});

test('flag ON: human-absence query derives a hard hasPeople=false constraint', () => {
  assert.deepEqual(deriveSearchConstraints('khóa thông minh không có người', FLAG_ON), { hasPeople: false });
  assert.deepEqual(deriveSearchConstraints('no people', FLAG_ON), { hasPeople: false });
});

test('flag ON: empty / whitespace query derives nothing', () => {
  assert.equal(deriveSearchConstraints('', FLAG_ON), undefined);
  assert.equal(deriveSearchConstraints('   ', FLAG_ON), undefined);
  assert.equal(deriveSearchConstraints(undefined, FLAG_ON), undefined);
});

test('flag ON: exact-SKU query derives NO hard constraint (SKU deferred to Phase 2B)', () => {
  // buildSearchPlan emits hardConstraints.sku for these, but Phase 1B must NOT
  // thread it into SQL -- canonical SKU identity is a Phase 2B concern.
  assert.equal(deriveSearchConstraints('HR-21', FLAG_ON), undefined);
  assert.equal(deriveSearchConstraints('DEMO-004', FLAG_ON), undefined);
});

test('flag ON: an ordinary query with no whitelisted negation derives nothing', () => {
  assert.equal(deriveSearchConstraints('đèn trần phòng khách', FLAG_ON), undefined);
  assert.equal(deriveSearchConstraints('không phải Acme', FLAG_ON), undefined); // soft brand negation only
});

// --- buildEligibilityWhere: baseline parity ---

test('category filter binds selected categories against the supported media_assets column', () => {
  const values: unknown[] = [];
  const where = buildEligibilityWhere(mkParams({ category: ['Studio', 'Banner'] }), values);
  assert.ok(where.includes('a.category = any($1::text[])'));
  assert.ok(!where.includes('a.sub_category'));
  assert.deepEqual(values, [['Studio', 'Banner']]);
});

test('baseline parity: omitted vs undefined constraints produce identical SQL + params', () => {
  const params = mkParams({ query: 'anything', category: ['lock'], source: ['Acme'], onlyPeople: true });
  const vA: unknown[] = [];
  const whereA = buildEligibilityWhere(params, vA, {});
  const vB: unknown[] = [];
  const whereB = buildEligibilityWhere(params, vB, {}, undefined);
  assert.deepEqual(whereB, whereA);
  assert.deepEqual(vB, vA);
});

test('flag-off end-to-end parity: derived (undefined) constraint == no constraint', () => {
  const params = mkParams({ query: 'khóa thông minh không có người', category: ['lock'] });
  const constraints = deriveSearchConstraints(params.query, FLAG_OFF); // undefined
  const v1: unknown[] = [];
  const withDerived = buildEligibilityWhere(params, v1, {}, constraints);
  const v2: unknown[] = [];
  const baseline = buildEligibilityWhere(params, v2, {});
  assert.deepEqual(withDerived, baseline);
  assert.deepEqual(v1, v2);
  assert.ok(!withDerived.some((c) => c.includes('= false')), 'no hard has_people predicate when flag off');
});

// --- buildEligibilityWhere: hard has_people predicate ---

test('hasPeople=false constraint emits the parameter-free exclusion predicate', () => {
  const params = mkParams({ query: 'không có người' });
  const values: unknown[] = [];
  const where = buildEligibilityWhere(params, values, {}, { hasPeople: false });
  assert.ok(where.includes(HAS_PEOPLE_FALSE), 'has_people=false predicate present');
  assert.equal(values.length, 0, 'the has_people predicate binds no $ placeholder');
});

test('adding the hasPeople constraint does not shift $-placeholder ordering', () => {
  const params = mkParams({ category: ['lock'], source: ['Acme'], permission: ['public'] });
  const vNo: unknown[] = [];
  buildEligibilityWhere(params, vNo, {});
  const vYes: unknown[] = [];
  buildEligibilityWhere(params, vYes, {}, { hasPeople: false });
  assert.deepEqual(vYes, vNo, 'same bound params in the same order regardless of the no-value hard predicate');
});

// --- UI filter vs query constraint separation ---

test('UI onlyPeople and query hasPeople=false are separate ANDed predicates; params never mutated', () => {
  const params = mkParams({ onlyPeople: true, category: ['lock'], source: ['Acme'] });
  const snapshot = JSON.stringify(params);
  const values: unknown[] = [];
  const where = buildEligibilityWhere(params, values, {}, { hasPeople: false });
  assert.ok(where.includes(HAS_PEOPLE_TRUE), 'UI onlyPeople predicate preserved');
  assert.ok(where.includes(HAS_PEOPLE_FALSE), 'query hasPeople=false predicate also present');
  assert.equal(JSON.stringify(params), snapshot, 'MediaListParams is not mutated by constraint wiring');
});

// --- permission / eligibility invariants hold regardless of constraints ---

test('permission + review + deletion predicates are unchanged by constraints', () => {
  const params = mkParams({ query: 'không có người' });
  for (const constraints of [undefined, { hasPeople: false as const }]) {
    const values: unknown[] = [];
    const where = buildEligibilityWhere(params, values, { canSeeInternal: false }, constraints);
    assert.ok(where.includes('a.deleted_at is null'), 'deleted rows excluded');
    assert.ok(where.includes(`a.review_state = 'approved'`), 'unapproved rows excluded');
    assert.ok(where.includes(`a.permission <> 'internal'`), 'internal hidden from viewer');
  }
});

test('deletedOnly / includeDeleted admin views are unaffected by constraints', () => {
  const params = mkParams({ query: 'không có người' });
  const values: unknown[] = [];
  const where = buildEligibilityWhere(params, values, { deletedOnly: true }, { hasPeople: false });
  assert.ok(where.includes('a.deleted_at is not null'), 'deletedOnly view preserved');
  assert.ok(!where.includes(`a.review_state = 'approved'`), 'deletedOnly does not force approved');
  // the query constraint still applies on top of the admin view
  assert.ok(where.includes(HAS_PEOPLE_FALSE));
});
