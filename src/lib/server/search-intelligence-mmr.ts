/**
 * Phase 2C -- Maximal Marginal Relevance (MMR) visual diversification.
 *
 * Semantic retrieval tends to surface clusters of near-identical photos (five
 * shots of the same lock from the same angle). MMR re-orders the displayed
 * prefix so consecutive results are visually distinct while staying relevant.
 *
 *   MMR(d_i) = argmax_{d_i in R\S} [ lambda * Sim1(d_i, q)
 *                                    - (1 - lambda) * max_{d_j in S} Sim2(d_i, d_j) ]
 *
 *   Sim1 = relevance from RRF fusion / DETERMINISTIC_RERANKER_V1 (combined score).
 *   Sim2 = pairwise cosine of 768-d SigLIP2 embeddings (public.asset_embeddings).
 *   lambda = relevance/diversity balance. Default 0.7 (70% relevance).
 *
 * TWO HARD SAFETY PROPERTIES (both covered by search-intelligence-mmr.test.ts):
 *
 *  1. TIER DOMINANCE IS PRESERVED. search-intelligence-exact.ts defines an
 *     absolute RankTier precedence: a Tier-0 exact SKU must never be displaced
 *     by a lower-tier item, regardless of visual diversity. MMR therefore runs
 *     *within each tier group only* and concatenates groups in ascending tier
 *     order. This is what keeps MMR compatible with the
 *     product_safe_false_positive_rate = 0 gate.
 *
 *  2. FAIL-CLOSED. Any missing/malformed embedding, out-of-range lambda, or
 *     degenerate input returns the ORIGINAL order unchanged (applied=false).
 *     MMR never drops, invents, or cross-tier-reorders candidates.
 *
 * GOVERNANCE: lambda=0.7 is a DEFAULT, not a tuned value. Per the Zero-Blind-
 * Tuning invariant it must be validated against Gold #42 (NDCG@10 must not
 * regress) before the VERITY_SEARCH_MMR_V1 flag is enabled in production.
 */

export const DEFAULT_MMR_LAMBDA = 0.7;
export const DEFAULT_MMR_POOL_SIZE = 40;
export const DEFAULT_MMR_OUTPUT_SIZE = 20;

export interface MmrCandidate {
  assetId: string;
  /** Absolute precedence from search-intelligence-exact.ts RankTier (lower = stronger). */
  rankTier: number;
  /** Sim1: relevance score from RRF fusion / reranker. Higher = more relevant. */
  relevance: number;
  /** 768-d SigLIP2 embedding. Absent/empty -> MMR fails closed to input order. */
  embedding?: readonly number[];
}

export interface MmrOptions {
  lambda?: number;
  poolSize?: number;
  outputSize?: number;
}

export interface MmrResult {
  /** Full candidate list, head re-ordered by MMR when applied; original order otherwise. */
  ordered: MmrCandidate[];
  /** True only when diversification actually ran over the pool. */
  applied: boolean;
  /** When applied=false, a short machine-readable reason (for telemetry). */
  skippedReason?: string;
}

/**
 * Cosine similarity of two numeric vectors. Returns 0 for length mismatch or a
 * zero-norm vector (both treated as "no measurable similarity", the safe value
 * for a diversity penalty). SigLIP2 vectors are unit-norm, so this reduces to a
 * dot product in practice, but we normalize defensively.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hasUsableEmbedding(c: MmrCandidate, dim: number): boolean {
  return (
    Array.isArray(c.embedding) &&
    c.embedding.length === dim &&
    c.embedding.every((v) => Number.isFinite(v))
  );
}

/** Deterministic ordering by relevance desc, then assetId asc. */
function byRelevanceThenId(a: MmrCandidate, b: MmrCandidate): number {
  if (b.relevance !== a.relevance) return b.relevance - a.relevance;
  return a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0;
}

/** Greedy MMR within a single tier group. All members are assumed embeddable. */
function mmrWithinGroup(group: MmrCandidate[], lambda: number): MmrCandidate[] {
  if (group.length <= 1) return group.slice();

  const remaining = group.slice().sort(byRelevanceThenId);
  const selected: MmrCandidate[] = [];

  // Seed with the single most relevant item.
  selected.push(remaining.shift() as MmrCandidate);

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const sim = cosineSimilarity(cand.embedding as number[], s.embedding as number[]);
        if (sim > maxSim) maxSim = sim;
      }
      const marginal = lambda * cand.relevance - (1 - lambda) * maxSim;
      // Deterministic tiebreak: higher marginal, then higher relevance, then
      // lower assetId (remaining is pre-sorted by relevance/id, so the first
      // strict maximum wins the tie).
      if (marginal > bestScore) {
        bestScore = marginal;
        bestIndex = i;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
}

/**
 * Diversify the top `poolSize` candidates with tier-respecting greedy MMR.
 * Candidates beyond the pool are appended unchanged. Fails closed to the input
 * order on any invalid input.
 */
export function mmrDiversify(
  candidates: readonly MmrCandidate[],
  options: MmrOptions = {},
): MmrResult {
  const lambda = options.lambda ?? DEFAULT_MMR_LAMBDA;
  const poolSize = options.poolSize ?? DEFAULT_MMR_POOL_SIZE;

  const passthrough = (skippedReason: string): MmrResult => ({
    ordered: candidates.slice(),
    applied: false,
    skippedReason,
  });

  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) return passthrough('LAMBDA_OUT_OF_RANGE');
  if (!Number.isFinite(poolSize) || poolSize <= 0) return passthrough('POOL_SIZE_INVALID');
  if (candidates.length <= 1) return passthrough('TOO_FEW_CANDIDATES');

  const pool = candidates.slice(0, poolSize);
  const tail = candidates.slice(poolSize);

  // Fail-closed if relevance is malformed anywhere in the pool.
  if (pool.some((c) => !Number.isFinite(c.relevance))) return passthrough('RELEVANCE_MALFORMED');

  // All pool candidates must share one embedding dimension; otherwise diversity
  // is meaningless and we must not reorder.
  const dim = Array.isArray(pool[0].embedding) ? pool[0].embedding!.length : 0;
  if (dim === 0) return passthrough('EMBEDDING_MISSING');
  if (!pool.every((c) => hasUsableEmbedding(c, dim))) return passthrough('EMBEDDING_MISSING');

  // Group the pool by tier (ascending) preserving first-seen tier order, then
  // diversify within each group. Cross-tier order is never changed.
  const tierOrder: number[] = [];
  const groups = new Map<number, MmrCandidate[]>();
  for (const c of pool) {
    if (!groups.has(c.rankTier)) {
      groups.set(c.rankTier, []);
      tierOrder.push(c.rankTier);
    }
    groups.get(c.rankTier)!.push(c);
  }
  tierOrder.sort((a, b) => a - b);

  const ordered: MmrCandidate[] = [];
  for (const tier of tierOrder) {
    ordered.push(...mmrWithinGroup(groups.get(tier)!, lambda));
  }
  ordered.push(...tail);

  return { ordered, applied: true };
}
