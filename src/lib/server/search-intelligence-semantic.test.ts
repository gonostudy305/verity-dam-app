import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_FUTURE_SEMANTIC_DIMENSION,
  CANONICAL_FUTURE_SEMANTIC_SPACE,
  nullSemanticRetriever,
  PostgresSiglip2SemanticRetriever,
  SemanticAdapterError,
  validateSemanticHits,
  type QueryablePoolLike,
  type SemanticHit,
} from './search-intelligence-semantic';

test('validateSemanticHits accepts valid hits', () => {
  const valid: SemanticHit[] = [
    { assetId: 'a-1', semanticScore: 0.95, semanticRank: 1, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
    { assetId: 'a-2', semanticScore: 0.82, semanticRank: 2, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
  ];
  const output = validateSemanticHits(valid);
  assert.equal(output.length, 2);
  assert.equal(output[0].assetId, 'a-1');
});

test('validateSemanticHits rejects wrong space id', () => {
  const invalid: SemanticHit[] = [
    { assetId: 'a-1', semanticScore: 0.95, semanticRank: 1, spaceId: 'wrong-space-id' },
  ];
  assert.throws(() => validateSemanticHits(invalid), SemanticAdapterError);
});

test('validateSemanticHits rejects non-finite scores', () => {
  const invalidNaN: SemanticHit[] = [
    { assetId: 'a-1', semanticScore: NaN, semanticRank: 1, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
  ];
  assert.throws(() => validateSemanticHits(invalidNaN), SemanticAdapterError);

  const invalidInf: SemanticHit[] = [
    { assetId: 'a-1', semanticScore: Infinity, semanticRank: 1, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
  ];
  assert.throws(() => validateSemanticHits(invalidInf), SemanticAdapterError);
});

test('validateSemanticHits rejects duplicate asset IDs', () => {
  const dupes: SemanticHit[] = [
    { assetId: 'a-1', semanticScore: 0.95, semanticRank: 1, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
    { assetId: 'a-1', semanticScore: 0.90, semanticRank: 2, spaceId: CANONICAL_FUTURE_SEMANTIC_SPACE },
  ];
  assert.throws(() => validateSemanticHits(dupes), SemanticAdapterError);
});

test('nullSemanticRetriever always returns empty array', async () => {
  const result = await nullSemanticRetriever.retrieve('khóa cửa thông minh', 10);
  assert.deepEqual(result, []);
});

test('PostgresSiglip2SemanticRetriever returns empty array when nl_search_space_id is null', async () => {
  const mockPool: QueryablePoolLike = {
    async query<T = any>(text: string, _values?: unknown[]): Promise<{ rows: T[] }> {
      if (text.includes('embedding_runtime_state')) {
        return { rows: [{ nl_search_space_id: null }] as unknown as T[] };
      }
      return { rows: [] };
    },
  };
  const mockClient = {
    async embedText() {
      return new Array(768).fill(0.1);
    },
  };

  const retriever = new PostgresSiglip2SemanticRetriever(mockPool, { embeddingClient: mockClient });
  const hits = await retriever.retrieve('công tắc đèn', 10);
  assert.deepEqual(hits, []);
});

test('PostgresSiglip2SemanticRetriever gracefully falls back when embedding client throws', async () => {
  const mockPool: QueryablePoolLike = {
    async query<T = any>(text: string, _values?: unknown[]): Promise<{ rows: T[] }> {
      if (text.includes('embedding_runtime_state')) {
        return { rows: [{ nl_search_space_id: CANONICAL_FUTURE_SEMANTIC_SPACE }] as unknown as T[] };
      }
      return { rows: [] };
    },
  };
  const failingClient = {
    async embedText() {
      throw new Error('Connection refused / 500ms timeout');
    },
  };

  const retriever = new PostgresSiglip2SemanticRetriever(mockPool, { embeddingClient: failingClient });
  const hits = await retriever.retrieve('công tắc đèn', 10);
  assert.deepEqual(hits, []);
});

test('PostgresSiglip2SemanticRetriever executes exact cosine scan when enabled', async () => {
  let executedSql = '';
  let executedValues: unknown[] = [];

  const mockPool: QueryablePoolLike = {
    async query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
      if (text.includes('embedding_runtime_state')) {
        return { rows: [{ nl_search_space_id: CANONICAL_FUTURE_SEMANTIC_SPACE }] as unknown as T[] };
      }
      if (text.includes('asset_embeddings')) {
        executedSql = text;
        executedValues = values || [];
        return {
          rows: [
            { asset_id: 'asset-siglip-1', similarity: 0.88 },
            { asset_id: 'asset-siglip-2', similarity: 0.79 },
          ] as unknown as T[],
        };
      }
      return { rows: [] };
    },
  };
  const mockClient = {
    async embedText() {
      return new Array(CANONICAL_FUTURE_SEMANTIC_DIMENSION).fill(0.05);
    },
  };

  const retriever = new PostgresSiglip2SemanticRetriever(mockPool, {
    canSeeInternal: false,
    embeddingClient: mockClient,
  });

  const hits = await retriever.retrieve('camera ngoài trời chống nước', 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].assetId, 'asset-siglip-1');
  assert.equal(hits[0].semanticScore, 0.88);
  assert.equal(hits[0].semanticRank, 1);
  assert.equal(hits[0].spaceId, CANONICAL_FUTURE_SEMANTIC_SPACE);

  // Check 15-case authorization and parameter integrity
  assert.ok(executedSql.includes('ORDER BY ae.vector <=> $1::vector ASC'));
  assert.equal(executedValues[1], CANONICAL_FUTURE_SEMANTIC_SPACE);
  assert.equal(executedValues[2], false); // canSeeInternal: viewer role cannot see internal
  assert.equal(executedValues[3], 10);    // topK
  assert.equal(executedValues[4], 0.08);  // minSimilarity floor
});