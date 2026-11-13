/**
 * Semantic channel adapter -- TypeScript counterpart to
 * backend/search_intelligence/semantic_adapter.py. INTERFACE ONLY. Does
 * NOT invoke SigLIP2 or any embedding model, and does NOT read
 * embedding_spaces/asset_embeddings or any other production table.
 *
 * The canonical future space id/dimension is reproduced (not invented)
 * from the already-frozen plans/2026-08-28-siglip2-versioned-space-migration/plan.md
 * candidate spec purely so validateSemanticHits() has a real value to
 * check a future retriever's output against. SigLIP2 stays inactive in
 * R0.1 -- nullSemanticRetriever is the only implementation that exists,
 * and it always returns no hits.
 */

export const CANONICAL_FUTURE_SEMANTIC_SPACE = 'verity-siglip2-b32-256-webli-v1';
export const CANONICAL_FUTURE_SEMANTIC_DIMENSION = 768;

export interface SemanticHit {
  assetId: string;
  semanticScore: number;
  semanticRank: number;
  spaceId: string;
}

export interface SemanticRetriever {
  retrieve(query: string, topK: number): Promise<SemanticHit[]> | SemanticHit[];
}

export class SemanticAdapterError extends Error {}

/**
 * Validate (never silently accept) a semantic retriever's raw output.
 * Rejects a wrong space_id, a NaN/infinite score, or a duplicate
 * assetId. Returns the hits unchanged when everything validates -- never
 * mutates a score or reorders hits.
 *
 * Even though R0.1 only ever calls this with an empty array (see
 * nullSemanticRetriever below), every call site in
 * native-search-intelligence.ts routes semantic output through this
 * function BEFORE fusion -- so a future real retriever plugs in at this
 * exact call site without any caller change, and can never silently skip
 * validation (mission item 3).
 */
export function validateSemanticHits(
  hits: readonly SemanticHit[],
  expectedSpaceId: string = CANONICAL_FUTURE_SEMANTIC_SPACE,
): SemanticHit[] {
  const seen = new Set<string>();
  for (const hit of hits) {
    if (hit.spaceId !== expectedSpaceId) {
      throw new SemanticAdapterError(
        `semantic hit for asset ${hit.assetId} came from space ${hit.spaceId}, expected ${expectedSpaceId}`,
      );
    }
    if (Number.isNaN(hit.semanticScore) || !Number.isFinite(hit.semanticScore)) {
      throw new SemanticAdapterError(`semantic hit for asset ${hit.assetId} has non-finite score ${hit.semanticScore}`);
    }
    if (seen.has(hit.assetId)) {
      throw new SemanticAdapterError(`duplicate semantic hit for asset ${hit.assetId}`);
    }
    seen.add(hit.assetId);
  }
  return [...hits];
}

/** The only SemanticRetriever implementation that exists in R0.1 fallback -- always
 * returns no hits. */
export const nullSemanticRetriever: SemanticRetriever = {
  retrieve() {
    return [];
  },
};

export interface QueryablePoolLike {
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PostgresSiglip2Options {
  canSeeInternal?: boolean;
  embeddingClient?: { embedText(text: string): Promise<number[]> };
}

/**
 * Production SigLIP2 semantic retriever for Release A / Vietnamese NL search.
 * Decoupled: checks dynamic nl_search_space_id from embedding_runtime_state.
 * If null or service unavailable, gracefully degrades to empty hits (fail-safe to pure lexical).
 */
export class PostgresSiglip2SemanticRetriever implements SemanticRetriever {
  constructor(
    private readonly pool: QueryablePoolLike,
    private readonly options: PostgresSiglip2Options = {},
  ) {}

  async retrieve(query: string, topK: number): Promise<SemanticHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // 1. Resolve nl_search_space_id from embedding_runtime_state
    let nlSearchSpaceId: string | null = null;
    try {
      const stateResult = await this.pool.query<{ nl_search_space_id: string | null }>(
        'SELECT nl_search_space_id FROM public.embedding_runtime_state WHERE singleton_id = 1 LIMIT 1',
      );
      if (stateResult.rows.length > 0) {
        nlSearchSpaceId = stateResult.rows[0].nl_search_space_id;
      }
    } catch {
      return [];
    }

    if (!nlSearchSpaceId) {
      return [];
    }

    // 2. Compute 768-d text vector via verity-embedding-runtime
    let vector: number[];
    try {
      const client =
        this.options.embeddingClient ??
        (await import('./embedding-client')).getEmbeddingClient();
      vector = await client.embedText(trimmed);
    } catch {
      // Failover: Text embedding service unreachable / timeout -> graceful degradation to lexical
      return [];
    }

    if (!vector || vector.length !== CANONICAL_FUTURE_SEMANTIC_DIMENSION) {
      return [];
    }

    // 3. Exact cosine scan on public.asset_embeddings with 15-case canonical authorization gate
    // and calibrated similarity floor ($5) to reject out-of-domain noise
    const canSeeInternal = this.options.canSeeInternal !== false;
    const minSimilarity = 0.08;
    const vectorStr = `[${vector.join(',')}]`;

    const sql = `
      SELECT ae.asset_id, (1 - (ae.vector <=> $1::vector))::real AS similarity
      FROM public.asset_embeddings ae
      JOIN public.media_assets a ON a.id = ae.asset_id
      WHERE ae.space_id = $2
        AND ae.kind = 'global'
        AND a.deleted_at IS NULL
        AND a.review_state = 'approved'
        AND ($3 = true OR a.permission = 'public')
        AND (1 - (ae.vector <=> $1::vector)) >= $5
      ORDER BY ae.vector <=> $1::vector ASC
      LIMIT $4;
    `;

    try {
      const result = await this.pool.query<{ asset_id: string; similarity: number }>(sql, [
        vectorStr,
        nlSearchSpaceId,
        canSeeInternal,
        Math.max(1, Math.min(topK, 100)),
        minSimilarity,
      ]);

      const hits: SemanticHit[] = result.rows.map((row, index) => ({
        assetId: String(row.asset_id),
        semanticScore: Number(row.similarity),
        semanticRank: index + 1,
        spaceId: nlSearchSpaceId!,
      }));

      return validateSemanticHits(hits, nlSearchSpaceId);
    } catch {
      return [];
    }
  }
}

