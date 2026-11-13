import { getNativePool } from './native-db';

export interface SearchConfig {
  rrf_k: number;
  semantic_weight: number;
  lexical_weight: number;
  mmr_lambda: number;
  mmr_pool_size: number;
  mmr_output_size: number;
  rerank_lexical: number;
  rerank_fuzzy: number;
  rerank_rrf: number;
  rerank_entity: number;
  semantic_enabled: boolean;
}

export const DEFAULT_SEARCH_CONFIG: Readonly<SearchConfig> = Object.freeze({
  rrf_k: 60,
  semantic_weight: 1.0,
  lexical_weight: 1.0,
  mmr_lambda: 0.7,
  mmr_pool_size: 40,
  mmr_output_size: 20,
  rerank_lexical: 1.0,
  rerank_fuzzy: 0.5,
  rerank_rrf: 10.0,
  rerank_entity: 1.0,
  semantic_enabled: true,
});

let cached: { config: SearchConfig; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function clearSearchConfigCache(): void {
  cached = null;
}

export async function loadSearchConfig(): Promise<SearchConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.config;
  }

  try {
    const pool = getNativePool();
    const res = await pool.query<{
      rrf_k: number;
      semantic_weight: number | string;
      lexical_weight: number | string;
      mmr_lambda: number | string;
      mmr_pool_size: number;
      mmr_output_size: number;
      rerank_lexical: number | string;
      rerank_fuzzy: number | string;
      rerank_rrf: number | string;
      rerank_entity: number | string;
      semantic_enabled?: boolean | string | null;
    }>('SELECT rrf_k, semantic_weight, lexical_weight, mmr_lambda, mmr_pool_size, mmr_output_size, rerank_lexical, rerank_fuzzy, rerank_rrf, rerank_entity, semantic_enabled FROM public.verity_search_config WHERE id = 1 LIMIT 1');

    if (res.rows.length > 0) {
      const row = res.rows[0];
      const parsed: SearchConfig = {
        rrf_k: Number(row.rrf_k) || DEFAULT_SEARCH_CONFIG.rrf_k,
        semantic_weight: Number(row.semantic_weight) ?? DEFAULT_SEARCH_CONFIG.semantic_weight,
        lexical_weight: Number(row.lexical_weight) ?? DEFAULT_SEARCH_CONFIG.lexical_weight,
        mmr_lambda: Number(row.mmr_lambda) ?? DEFAULT_SEARCH_CONFIG.mmr_lambda,
        mmr_pool_size: Number(row.mmr_pool_size) || DEFAULT_SEARCH_CONFIG.mmr_pool_size,
        mmr_output_size: Number(row.mmr_output_size) || DEFAULT_SEARCH_CONFIG.mmr_output_size,
        rerank_lexical: Number(row.rerank_lexical) ?? DEFAULT_SEARCH_CONFIG.rerank_lexical,
        rerank_fuzzy: Number(row.rerank_fuzzy) ?? DEFAULT_SEARCH_CONFIG.rerank_fuzzy,
        rerank_rrf: Number(row.rerank_rrf) ?? DEFAULT_SEARCH_CONFIG.rerank_rrf,
        rerank_entity: Number(row.rerank_entity) ?? DEFAULT_SEARCH_CONFIG.rerank_entity,
        semantic_enabled: row.semantic_enabled !== undefined && row.semantic_enabled !== null
          ? String(row.semantic_enabled) === 'true' || row.semantic_enabled === true
          : DEFAULT_SEARCH_CONFIG.semantic_enabled,
      };
      cached = { config: parsed, at: now };
      return parsed;
    }
  } catch {
    // Database down or unconfigured during build/cold start: graceful fallback
  }

  return { ...DEFAULT_SEARCH_CONFIG };
}
