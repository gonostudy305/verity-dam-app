import assert from 'node:assert/strict';
import test from 'node:test';

import { libraryOrderBy } from './native-media';

// Offset pagination is only stable when the ORDER BY is a total order. Assets
// imported in bulk share created_at/usage_count, so each sort must end in a
// unique tie-breaker or pages can repeat/skip rows.

test('every library sort ends with the unique id tie-breaker', () => {
  for (const sort of ['newest', 'most_used', 'unused'] as const) {
    assert.match(libraryOrderBy(sort), /, a\.id desc$/, sort);
  }
});

test('sorts keep their primary meaning', () => {
  assert.match(libraryOrderBy('newest'), /^a\.created_at desc/);
  assert.match(libraryOrderBy('most_used'), /^coalesce\(a\.usage_count, 0\) desc/);
  assert.match(libraryOrderBy('unused'), /^coalesce\(a\.usage_count, 0\) asc/);
});

test('most_used and unused are different orders', () => {
  assert.notEqual(libraryOrderBy('most_used'), libraryOrderBy('unused'));
});
