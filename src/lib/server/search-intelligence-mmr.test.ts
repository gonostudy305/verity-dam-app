import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cosineSimilarity,
  mmrDiversify,
  DEFAULT_MMR_LAMBDA,
  type MmrCandidate,
} from './search-intelligence-mmr';
import { isSearchMmrV1Enabled } from './search-intelligence-flag';

const order = (r: { ordered: MmrCandidate[] }): string[] => r.ordered.map((c) => c.assetId);

test('cosineSimilarity: identical=1, orthogonal=0, mismatch/zero=0', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0, 'length mismatch -> 0');
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'zero-norm -> 0');
  assert.ok(cosineSimilarity([2, 0], [1, 0]) > 0.999, 'non-unit vectors normalized');
});

test('mmrDiversify: preserves absolute tier dominance (never cross-tier reorder)', () => {
  // A very diverse, highly relevant Tier-4 item must NOT jump above a Tier-0
  // exact SKU match, no matter how much diversity it would add.
  const candidates: MmrCandidate[] = [
    { assetId: 'exact-0', rankTier: 0, relevance: 0.1, embedding: [1, 0, 0] },
    { assetId: 'rel-a', rankTier: 4, relevance: 0.9, embedding: [0, 1, 0] },
    { assetId: 'rel-b', rankTier: 4, relevance: 0.8, embedding: [0, 0, 1] },
  ];
  const result = mmrDiversify(candidates, { lambda: 0.7 });
  assert.equal(result.applied, true);
  // Tier must be non-decreasing across the whole output.
  const tiers = result.ordered.map((c) => c.rankTier);
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i] >= tiers[i - 1], 'tiers must be non-decreasing');
  }
  assert.equal(result.ordered[0].assetId, 'exact-0', 'Tier-0 exact stays first');
});

test('mmrDiversify: demotes a near-duplicate in favor of a diverse candidate (within tier)', () => {
  // A and B are visually identical; C is orthogonal. Relevance A > B > C.
  // Greedy MMR picks A (top relevance), then C (diverse) before B (dup of A).
  const candidates: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.95, embedding: [1, 0, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.9, embedding: [1, 0, 0] },
    { assetId: 'C', rankTier: 4, relevance: 0.5, embedding: [0, 1, 0] },
  ];
  const result = mmrDiversify(candidates, { lambda: 0.5 });
  assert.equal(result.applied, true);
  const ids = order(result);
  assert.equal(ids[0], 'A', 'most relevant seeds the list');
  assert.ok(ids.indexOf('C') < ids.indexOf('B'), 'diverse C outranks near-duplicate B');
});

test('mmrDiversify: lambda=1 is pure relevance order (no diversity effect)', () => {
  const candidates: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.4, embedding: [1, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.9, embedding: [1, 0] },
    { assetId: 'C', rankTier: 4, relevance: 0.6, embedding: [0, 1] },
  ];
  const result = mmrDiversify(candidates, { lambda: 1 });
  assert.deepEqual(order(result), ['B', 'C', 'A']);
});

test('mmrDiversify: deterministic across repeated runs', () => {
  const candidates: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.9, embedding: [1, 0, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.9, embedding: [0, 1, 0] },
    { assetId: 'C', rankTier: 4, relevance: 0.9, embedding: [0, 0, 1] },
  ];
  const first = order(mmrDiversify(candidates, { lambda: DEFAULT_MMR_LAMBDA }));
  const second = order(mmrDiversify(candidates, { lambda: DEFAULT_MMR_LAMBDA }));
  assert.deepEqual(first, second);
});

test('mmrDiversify: only the pool is diversified; the tail is appended unchanged', () => {
  const candidates: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.95, embedding: [1, 0, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.9, embedding: [1, 0, 0] },
    { assetId: 'C', rankTier: 4, relevance: 0.5, embedding: [0, 1, 0] },
    { assetId: 'tail-1', rankTier: 4, relevance: 0.4, embedding: [0, 0, 1] },
    { assetId: 'tail-2', rankTier: 4, relevance: 0.3, embedding: [0, 0, 1] },
  ];
  const result = mmrDiversify(candidates, { lambda: 0.5, poolSize: 3 });
  const ids = order(result);
  assert.deepEqual(ids.slice(3), ['tail-1', 'tail-2'], 'tail preserved in original order');
  assert.equal(ids.length, 5, 'no candidate dropped');
});

test('mmrDiversify: fails closed (original order) on missing embeddings', () => {
  const candidates: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.9, embedding: [1, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.8 }, // no embedding
  ];
  const result = mmrDiversify(candidates, { lambda: 0.7 });
  assert.equal(result.applied, false);
  assert.equal(result.skippedReason, 'EMBEDDING_MISSING');
  assert.deepEqual(order(result), ['A', 'B']);
});

test('mmrDiversify: fails closed on out-of-range lambda and degenerate input', () => {
  const two: MmrCandidate[] = [
    { assetId: 'A', rankTier: 4, relevance: 0.9, embedding: [1, 0] },
    { assetId: 'B', rankTier: 4, relevance: 0.8, embedding: [0, 1] },
  ];
  assert.equal(mmrDiversify(two, { lambda: 1.5 }).applied, false);
  assert.equal(mmrDiversify(two, { lambda: -0.1 }).applied, false);
  assert.equal(mmrDiversify([two[0]], { lambda: 0.7 }).applied, false, 'single candidate');
  assert.equal(mmrDiversify([], { lambda: 0.7 }).applied, false, 'empty');
});

test('flag: isSearchMmrV1Enabled defaults OFF and only true for the exact "true" string', () => {
  assert.equal(isSearchMmrV1Enabled({}), false);
  assert.equal(isSearchMmrV1Enabled({ VERITY_SEARCH_MMR_V1_ENABLED: 'false' }), false);
  assert.equal(isSearchMmrV1Enabled({ VERITY_SEARCH_MMR_V1_ENABLED: '1' }), false);
  assert.equal(isSearchMmrV1Enabled({ VERITY_SEARCH_MMR_V1_ENABLED: 'true' }), true);
});
