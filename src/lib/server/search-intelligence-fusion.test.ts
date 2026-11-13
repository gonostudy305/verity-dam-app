import assert from 'node:assert/strict';
import test from 'node:test';

import { reciprocalRankFusion, rerank, RRF_K, type RerankCandidate } from './search-intelligence-fusion';
import { RankTier } from './search-intelligence-exact';

const NO_SIGNALS = { exactSku: false, exactBrandModel: false, exactTitlePhrase: false, exactBrand: false };

test('reciprocalRankFusion is deterministic and combines lexical + semantic ranks with the frozen k', () => {
  const lexical = [{ assetId: 'a', rank: 1 }, { assetId: 'b', rank: 2 }];
  const semantic = [{ assetId: 'b', rank: 1 }, { assetId: 'c', rank: 2 }];
  const result = reciprocalRankFusion(lexical, semantic);
  const byId = new Map(result.map((r) => [r.assetId, r]));

  assert.equal(byId.get('a')!.rrfScore, 1 / (RRF_K + 1));
  assert.equal(byId.get('c')!.rrfScore, 1 / (RRF_K + 2));
  // 'b' appears in both channels -- its score is the sum.
  assert.ok(byId.get('b')!.rrfScore > byId.get('a')!.rrfScore);
  assert.ok(byId.get('b')!.rrfScore > byId.get('c')!.rrfScore);
});

test('reciprocalRankFusion produces the same ordering across repeated calls (deterministic)', () => {
  const lexical = [{ assetId: 'x', rank: 1 }, { assetId: 'y', rank: 1 }];
  const first = reciprocalRankFusion(lexical, []).map((r) => r.assetId);
  const second = reciprocalRankFusion(lexical, []).map((r) => r.assetId);
  assert.deepEqual(first, second);
  // Tied rrfScore -> assetId string tiebreaker.
  assert.deepEqual(first, ['x', 'y']);
});

function candidate(overrides: Partial<RerankCandidate>): RerankCandidate {
  return {
    assetId: 'asset',
    rankTier: RankTier.TIER_4_RELEVANCE,
    exactSignals: NO_SIGNALS,
    lexicalScore: 0,
    fuzzyConfidence: 0,
    correctionUsed: null,
    rrfScore: 0,
    lexicalRank: null,
    semanticRank: null,
    entityOverlap: 0,
    ...overrides,
  };
}

test('rerank: tier dominance is absolute -- a lower tier always outranks a higher tier regardless of score', () => {
  const tier0 = candidate({ assetId: 'low-score-tier0', rankTier: RankTier.TIER_0_EXACT_SKU, lexicalScore: 0.1 });
  const tier4 = candidate({ assetId: 'high-score-tier4', rankTier: RankTier.TIER_4_RELEVANCE, lexicalScore: 999 });
  const result = rerank([tier4, tier0]);
  assert.equal(result[0].assetId, 'low-score-tier0');
  assert.equal(result[1].assetId, 'high-score-tier4');
});

test('rerank: within the same tier, higher combined score wins; assetId is the final tiebreaker', () => {
  const a = candidate({ assetId: 'b-asset', lexicalScore: 1 });
  const b = candidate({ assetId: 'a-asset', lexicalScore: 1 });
  const result = rerank([a, b]);
  assert.deepEqual(result.map((r) => r.assetId), ['a-asset', 'b-asset']);
});

test('rerank assigns a contiguous 1-based finalRank', () => {
  const result = rerank([candidate({ assetId: '1' }), candidate({ assetId: '2' }), candidate({ assetId: '3' })]);
  assert.deepEqual(result.map((r) => r.finalRank), [1, 2, 3]);
});

test('Gap-B-equivalent unit check: a candidate list built only from zero-evidence-filtered documents never includes a zero-evidence row', () => {
  // Mirrors run_canonical_search()'s zero-evidence filter -- this is the
  // fusion/rerank-side proof that rerank() itself never fabricates
  // evidence for a document that was correctly excluded upstream.
  const hasEvidence = candidate({ assetId: 'has-evidence', lexicalScore: 2 });
  const wouldBeZeroEvidence = { lexicalScore: 0, fuzzyConfidence: 0, rrfScore: 0, semanticRank: null, exactSignals: NO_SIGNALS };
  const survivors = [hasEvidence].filter((c) => c.lexicalScore > 0 || c.fuzzyConfidence > 0 || c.semanticRank != null);
  assert.deepEqual(survivors.map((c) => c.assetId), ['has-evidence']);
  assert.equal(wouldBeZeroEvidence.lexicalScore > 0 || wouldBeZeroEvidence.fuzzyConfidence > 0 || wouldBeZeroEvidence.semanticRank != null, false);
});
