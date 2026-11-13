import assert from 'node:assert/strict';
import test from 'node:test';

import { isIntelligenceEligible } from './search-intelligence-route-policy';

const BASE = { flagEnabled: true, query: 'acme', sort: 'newest' as const, includeDeleted: false, deletedOnly: false };

test('Item 13/16: flag disabled -> exact BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, flagEnabled: false }), false);
});

test('empty query -> BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, query: '' }), false);
});

test('Item 12: explicit sort=most_used -> BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, sort: 'most_used' }), false);
});

test('Item 12: explicit sort=unused -> BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, sort: 'unused' }), false);
});

test('include_deleted admin view -> BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, includeDeleted: true }), false);
});

test('deleted_only admin view -> BASELINE_L0 (ineligible)', () => {
  assert.equal(isIntelligenceEligible({ ...BASE, deletedOnly: true }), false);
});

test('default case: flag on + non-empty query + sort=newest + not a deleted view -> eligible', () => {
  assert.equal(isIntelligenceEligible(BASE), true);
});
