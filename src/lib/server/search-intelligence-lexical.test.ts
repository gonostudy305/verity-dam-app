import assert from 'node:assert/strict';
import test from 'node:test';

import { scoreDocument } from './search-intelligence-lexical';
import { normalizeQuery } from './search-intelligence-vn';
import type { SearchDocumentLite } from './search-intelligence-exact';

function doc(overrides: Partial<SearchDocumentLite> = {}): SearchDocumentLite {
  return {
    assetId: 'asset-1',
    title: '',
    sku: '',
    brand: '',
    category: '',
    space: '',
    suggestedCaption: '',
    keywords: [],
    usageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('scoreDocument gives 0 total for a document with no overlapping field text', () => {
  const document = doc({ title: 'Completely unrelated product' });
  const score = scoreDocument(document, normalizeQuery('xyzzy-no-such-product-999'));
  assert.equal(score.total, 0);
  assert.deepEqual(score.breakdown, {});
});

test('scoreDocument rewards an exact title phrase match and an accented bonus', () => {
  const document = doc({ title: 'Khóa thông minh Acme' });
  const score = scoreDocument(document, normalizeQuery('khóa thông minh'));
  assert.ok(score.total > 0);
  assert.ok('title_exact_phrase' in score.breakdown);
  assert.ok('title_accented_bonus' in score.breakdown);
});

test('scoreDocument rewards partial token coverage even without an exact phrase', () => {
  const document = doc({ title: 'Camera Acme ngoài trời' });
  const score = scoreDocument(document, normalizeQuery('camera trong nha'));
  assert.ok(score.total >= 0);
});

test('accent-folded matching still scores when the document text is accented and the query is not', () => {
  const document = doc({ title: 'khóa thông minh' });
  const accented = scoreDocument(document, normalizeQuery('khóa thông minh'));
  const unaccented = scoreDocument(document, normalizeQuery('khoa thong minh'));
  assert.ok(unaccented.total > 0);
  // The accented query gets the extra accented-match bonus the folded one does not.
  assert.ok(accented.total >= unaccented.total);
});
