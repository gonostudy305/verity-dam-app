/**
 * Reciprocal Rank Fusion (RRF) + DETERMINISTIC_RERANKER_V1 -- TypeScript
 * counterpart to backend/search_intelligence/rrf_fusion.py and reranker.py.
 *
 * HYBRID_BASELINE_RRF is the same frozen, un-tuned config: semantic depth
 * 100, lexical depth 100, rrf_k=60, weights 1.0/1.0. No tuning surface.
 *
 * DETERMINISTIC_RERANKER_V1 is explicitly rule-based -- NEVER machine
 * learning. Tier dominance (search-intelligence-exact.ts's RankTier) is
 * absolute: two candidates in different tiers are never reordered by
 * score; asset_id is the final, fully-deterministic tiebreaker.
 */

import type { RankTier } from './search-intelligence-exact';
import type { ExactSignals } from './search-intelligence-exact';

export const RRF_K = 60;
export const SEMANTIC_DEPTH = 100;
export const LEXICAL_DEPTH = 100;
export const SEMANTIC_WEIGHT = 1.0;
export const LEXICAL_WEIGHT = 1.0;

export interface RankedChannelHit {
  assetId: string;
  rank: number;
}

export interface RrfResult {
  assetId: string;
  rrfScore: number;
  lexicalRank: number | null;
  semanticRank: number | null;
}

export interface FusionOptions {
  rrfK?: number;
  semanticDepth?: number;
  lexicalDepth?: number;
  semanticWeight?: number;
  lexicalWeight?: number;
}

export function reciprocalRankFusion(
  lexicalRanked: readonly RankedChannelHit[],
  semanticRanked: readonly RankedChannelHit[],
  options: FusionOptions = {},
): RrfResult[] {
  const rrfK = options.rrfK ?? RRF_K;
  const semanticDepth = options.semanticDepth ?? SEMANTIC_DEPTH;
  const lexicalDepth = options.lexicalDepth ?? LEXICAL_DEPTH;
  const semanticWeight = options.semanticWeight ?? SEMANTIC_WEIGHT;
  const lexicalWeight = options.lexicalWeight ?? LEXICAL_WEIGHT;

  const lexicalById = new Map<string, number>();
  for (const hit of lexicalRanked.slice(0, lexicalDepth)) lexicalById.set(hit.assetId, hit.rank);
  const semanticById = new Map<string, number>();
  for (const hit of semanticRanked.slice(0, semanticDepth)) semanticById.set(hit.assetId, hit.rank);

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const assetId of [...lexicalById.keys(), ...semanticById.keys()]) {
    if (!seen.has(assetId)) {
      seen.add(assetId);
      orderedIds.push(assetId);
    }
  }

  const results: RrfResult[] = orderedIds.map((assetId) => {
    const lexicalRank = lexicalById.get(assetId) ?? null;
    const semanticRank = semanticById.get(assetId) ?? null;
    let score = 0;
    if (lexicalRank !== null) score += lexicalWeight / (rrfK + lexicalRank);
    if (semanticRank !== null) score += semanticWeight / (rrfK + semanticRank);
    return { assetId, rrfScore: score, lexicalRank, semanticRank };
  });

  results.sort((a, b) => (b.rrfScore !== a.rrfScore ? b.rrfScore - a.rrfScore : a.assetId < b.assetId ? -1 : 1));
  return results;
}

export const RERANKER_NAME = 'DETERMINISTIC_RERANKER_V1';

export const RERANK_WEIGHTS_ONLY = {
  lexicalScore: 1.0,
  fuzzyConfidence: 0.5,
  rrfScore: 10.0,
  entityOverlap: 1.0,
};

export type RerankWeights = typeof RERANK_WEIGHTS_ONLY;

export interface RerankCandidate {
  assetId: string;
  rankTier: RankTier;
  exactSignals: ExactSignals;
  lexicalScore: number;
  fuzzyConfidence: number;
  correctionUsed: string | null;
  rrfScore: number;
  lexicalRank: number | null;
  semanticRank: number | null;
  entityOverlap: number;
}

export interface RerankedResult {
  assetId: string;
  finalRank: number;
  rankTier: RankTier;
  combinedScore: number;
}

function combinedScore(candidate: RerankCandidate, weights: RerankWeights = RERANK_WEIGHTS_ONLY): number {
  return (
    candidate.lexicalScore * weights.lexicalScore +
    candidate.fuzzyConfidence * weights.fuzzyConfidence +
    candidate.rrfScore * weights.rrfScore +
    candidate.entityOverlap * weights.entityOverlap
  );
}

export function rerank(
  candidates: readonly RerankCandidate[],
  weights?: Partial<RerankWeights>,
): RerankedResult[] {
  const activeWeights: RerankWeights = {
    lexicalScore: weights?.lexicalScore ?? RERANK_WEIGHTS_ONLY.lexicalScore,
    fuzzyConfidence: weights?.fuzzyConfidence ?? RERANK_WEIGHTS_ONLY.fuzzyConfidence,
    rrfScore: weights?.rrfScore ?? RERANK_WEIGHTS_ONLY.rrfScore,
    entityOverlap: weights?.entityOverlap ?? RERANK_WEIGHTS_ONLY.entityOverlap,
  };

  const ordered = [...candidates].sort((a, b) => {
    if (a.rankTier !== b.rankTier) return a.rankTier - b.rankTier;
    const scoreDiff = combinedScore(b, activeWeights) - combinedScore(a, activeWeights);
    if (scoreDiff !== 0) return scoreDiff;
    return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
  });

  return ordered.map((candidate, index) => ({
    assetId: candidate.assetId,
    finalRank: index + 1,
    rankTier: candidate.rankTier,
    combinedScore: combinedScore(candidate, activeWeights),
  }));
}
