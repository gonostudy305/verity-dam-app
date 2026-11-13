import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSimilarity } from './DuplicateCompareModal';

test('formatSimilarity formats decimal and whole percentages correctly with 2 decimal places', () => {
  // Float normalized between 0 and 1
  assert.equal(formatSimilarity(0.9433627), '94.34%');
  assert.equal(formatSimilarity(0.85), '85.00%');
  assert.equal(formatSimilarity(0.9999), '99.99%');
  assert.equal(formatSimilarity(0.005), '0.50%');

  // Percentage passed directly (> 1)
  assert.equal(formatSimilarity(92), '92.00%');
  assert.equal(formatSimilarity(94.34), '94.34%');

  // Edge cases
  assert.equal(formatSimilarity(0), '0%');
  assert.equal(formatSimilarity(undefined), '0%');
});
