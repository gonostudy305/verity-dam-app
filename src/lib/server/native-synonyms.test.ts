import assert from 'node:assert/strict';
import test from 'node:test';

import { expandSearchTerms, stripSearchStopwords } from './native-synonyms';
import { buildIlikeTermCondition } from './native-media';
import type { SynonymItem } from './synonym-types';

// Regression coverage for the 2026-09-07 bug report: searching "ảnh robot"
// returned 0 results while "robot" alone returned 4. Root cause:
// expandSearchTerms/buildIlikeTermCondition built ONE literal ILIKE
// substring out of the whole raw query -- "ảnh" is a Vietnamese
// search-INTENT word ("I want a PHOTO of X") that never appears IN any
// indexed field (caption/title/keywords describe the subject, never call
// themselves "ảnh"), so "%ảnh robot%" never matched any row even though
// "%robot%" matched four. These tests are pure (no DB, no network).

// --- stripSearchStopwords ---

test('strips a leading search-intent stopword', () => {
  assert.equal(stripSearchStopwords('ảnh robot'), 'robot');
});

test('strips multiple stopword tokens anywhere in the query', () => {
  assert.equal(stripSearchStopwords('hình ảnh robot'), 'robot');
  assert.equal(stripSearchStopwords('tấm ảnh robot đẹp'), 'robot đẹp');
});

test('is case-insensitive (vi-VN locale)', () => {
  assert.equal(stripSearchStopwords('Ảnh robot'), 'robot');
  assert.equal(stripSearchStopwords('ẢNH robot'), 'robot');
});

test('never empties a stopword-only query -- falls back to the original', () => {
  assert.equal(stripSearchStopwords('ảnh'), 'ảnh');
  assert.equal(stripSearchStopwords('ảnh hình'), 'ảnh hình');
});

test('leaves an ordinary content query untouched', () => {
  assert.equal(stripSearchStopwords('robot'), 'robot');
  assert.equal(stripSearchStopwords('khóa cửa thông minh'), 'khóa cửa thông minh');
});

test('does not break internal hyphens (SKU-like tokens)', () => {
  assert.equal(stripSearchStopwords('ảnh HR-21'), 'HR-21');
});

test('empty / whitespace-only input returns empty', () => {
  assert.equal(stripSearchStopwords(''), '');
  assert.equal(stripSearchStopwords('   '), '');
});

// --- stripSearchStopwords composed with expandSearchTerms: the actual fix ---

const NO_SYNONYMS: SynonymItem[] = [];
const SAMPLE_SYNONYMS: SynonymItem[] = [
  { id: '1', from: 'cam bien', to: 'Sensor P1, Cảm biến cửa, Cảm biến hiện diện FP2' },
  { id: '2', from: 'khóa', to: 'Acme M100, Acme A100, Acme U100' },
];

test('"ảnh robot" produces the exact same search terms as "robot" alone', () => {
  const stripped = stripSearchStopwords('ảnh robot');
  const withStopword = expandSearchTerms(stripped, NO_SYNONYMS);
  const withoutStopword = expandSearchTerms('robot', NO_SYNONYMS);
  assert.deepEqual(withStopword, withoutStopword);
});

test('multi-word synonym keys ("cam bien") still match after stopword stripping', () => {
  // "ảnh" is stripped but "cam bien" survives as one contiguous phrase, so
  // the existing whole-phrase synonym match is unaffected.
  const stripped = stripSearchStopwords('ảnh cam bien');
  assert.equal(stripped, 'cam bien');
  const terms = expandSearchTerms(stripped, SAMPLE_SYNONYMS);
  assert.ok(terms.includes('Sensor P1'));
  assert.ok(terms.includes('Cảm biến cửa'));
});

test('single-word synonym keys ("khóa") still match after stopword stripping', () => {
  const stripped = stripSearchStopwords('hình ảnh khóa');
  assert.equal(stripped, 'khóa');
  const terms = expandSearchTerms(stripped, SAMPLE_SYNONYMS);
  assert.ok(terms.includes('Acme M100'));
});

// --- end-to-end with the actual SQL condition builder (still no DB) ---

test('the built ILIKE condition for "ảnh robot" is identical to "robot" alone', () => {
  const strippedTerms = expandSearchTerms(stripSearchStopwords('ảnh robot'), NO_SYNONYMS);
  const valuesA: unknown[] = [];
  const conditionsA = strippedTerms.map((term) => buildIlikeTermCondition(term, valuesA));

  const plainTerms = expandSearchTerms('robot', NO_SYNONYMS);
  const valuesB: unknown[] = [];
  const conditionsB = plainTerms.map((term) => buildIlikeTermCondition(term, valuesB));

  assert.deepEqual(conditionsA, conditionsB);
  assert.deepEqual(valuesA, valuesB);
});
