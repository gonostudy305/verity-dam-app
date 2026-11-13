import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedExactSpanMatch, normalizeForMatch, normalizeQuery, stripDiacritics, tokenize } from './search-intelligence-vn';

test('normalizeQuery lowercases, NFC-normalizes, and collapses whitespace', () => {
  const result = normalizeQuery('  Khóa   Thông Minh  ');
  assert.equal(result.lowercaseForm, '  khóa   thông minh  '.toLowerCase());
  assert.equal(result.normalizedWhitespace, 'khóa thông minh');
  assert.equal(result.accentedNormalized, 'khóa thông minh');
});

test('stripDiacritics folds Vietnamese tone marks and đ/Đ', () => {
  assert.equal(stripDiacritics('khóa thông minh'), 'khoa thong minh');
  assert.equal(stripDiacritics('Đèn'), 'Den');
  assert.equal(stripDiacritics('robot hút bụi'), 'robot hut bui');
});

test('tokenize keeps internal hyphens as part of one token (SKU/brand codes)', () => {
  assert.deepEqual(tokenize('HR-21 tp-link'), ['HR-21', 'tp-link']);
  assert.deepEqual(tokenize('!!!'), []);
});

test('normalizeForMatch case-folds and collapses whitespace but preserves punctuation', () => {
  assert.equal(normalizeForMatch('  ABC-123  '), 'abc-123');
  assert.equal(normalizeForMatch('PX-80x(8MP+2MP,4mm)'), 'px-80x(8mp+2mp,4mm)');
});

test('boundedExactSpanMatch: "ABC-123" matches as a bounded span inside a larger query', () => {
  assert.equal(boundedExactSpanMatch('abc-123', 'abc-123'), true);
  assert.equal(boundedExactSpanMatch('abc-123', 'acme abc-123'), true);
  assert.equal(boundedExactSpanMatch('abc-123', 'abc-123 for living room'), true);
});

test('boundedExactSpanMatch: "ABC-123" must NOT match inside "ABC-1234" (either direction)', () => {
  assert.equal(boundedExactSpanMatch('abc-123', 'abc-1234'), false);
  assert.equal(boundedExactSpanMatch('abc-1234', 'abc-123'), false);
});

test('boundedExactSpanMatch: empty needle never matches', () => {
  assert.equal(boundedExactSpanMatch('', 'anything'), false);
});
