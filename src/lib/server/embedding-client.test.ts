import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTextEmbedding } from './embedding-client';
import { CANONICAL_FUTURE_SEMANTIC_SPACE, CANONICAL_FUTURE_SEMANTIC_DIMENSION } from './search-intelligence-semantic';

test('fetchTextEmbedding returns null for empty queries', async () => {
  const result = await fetchTextEmbedding('   ');
  assert.equal(result, null);
});

test('fetchTextEmbedding gracefully handles unreachable endpoint without throwing', async () => {
  const result = await fetchTextEmbedding('khóa cửa thông minh', CANONICAL_FUTURE_SEMANTIC_SPACE, 'http://127.0.0.1:59999');
  assert.equal(result, null);
});
