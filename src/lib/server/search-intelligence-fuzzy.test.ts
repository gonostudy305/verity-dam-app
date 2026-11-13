import assert from 'node:assert/strict';
import test from 'node:test';

import { correctQueryTokens, correctToken, MAX_CANDIDATES_PER_TOKEN, MAX_TOTAL_CANDIDATES } from './search-intelligence-fuzzy';

test('"acmee" corrects toward "acme"', () => {
  const corrections = correctToken('acmee');
  assert.ok(corrections.some((c) => c.correctedToken === 'acme'), JSON.stringify(corrections));
});

test('"driit" corrects toward "drift"', () => {
  const corrections = correctToken('driit');
  assert.ok(corrections.some((c) => c.correctedToken === 'drift'), JSON.stringify(corrections));
});

test('"robork" corrects toward "robot"', () => {
  const corrections = correctToken('robork');
  assert.ok(corrections.some((c) => c.correctedToken === 'robot'), JSON.stringify(corrections));
});

test('tokens shorter than 3 characters are never corrected', () => {
  assert.deepEqual(correctToken('ab'), []);
  assert.deepEqual(correctToken(''), []);
});

test('an already-exact vocabulary word yields no corrections', () => {
  assert.deepEqual(correctToken('acme'), []);
});

test('correctToken is bounded at MAX_CANDIDATES_PER_TOKEN', () => {
  const corrections = correctToken('robo'); // plausibly close to several short vocab words
  assert.ok(corrections.length <= MAX_CANDIDATES_PER_TOKEN);
});

test('correctQueryTokens("robot hut bui") corrects the multi-word typo query toward "robot hut bui"-adjacent vocabulary', () => {
  const corrections = correctQueryTokens(['robot', 'hut', 'bui']);
  const correctedWords = corrections.map((c) => c.correctedToken);
  assert.ok(correctedWords.includes('hút') || correctedWords.includes('bụi'), JSON.stringify(corrections));
});

test('correctQueryTokens is bounded at MAX_TOTAL_CANDIDATES and deduplicated', () => {
  const manyTokens = ['acmee', 'driit', 'robork', 'akai', 'ezvis', 'dahau', 'xiaoim', 'hikvison'];
  const corrections = correctQueryTokens(manyTokens);
  assert.ok(corrections.length <= MAX_TOTAL_CANDIDATES);
  const seen = new Set(corrections.map((c) => c.correctedToken));
  assert.equal(seen.size, corrections.length);
});
