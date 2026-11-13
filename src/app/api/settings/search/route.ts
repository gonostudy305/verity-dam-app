import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import {
  DEFAULT_SEARCH_CONFIG,
  clearSearchConfigCache,
  loadSearchConfig,
  type SearchConfig,
} from '@/lib/server/search-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireNativeAdmin();
    const data = await loadSearchConfig();
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await requireNativeAdmin();
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== 'object') {
      throw new ApiError(400, 'INVALID_BODY', 'Request body must be a valid JSON object');
    }

    const rrf_k = Number.isInteger(body.rrf_k) && body.rrf_k > 0 ? body.rrf_k : DEFAULT_SEARCH_CONFIG.rrf_k;
    const semantic_weight = typeof body.semantic_weight === 'number' && Number.isFinite(body.semantic_weight) && body.semantic_weight >= 0
      ? body.semantic_weight : DEFAULT_SEARCH_CONFIG.semantic_weight;
    const lexical_weight = typeof body.lexical_weight === 'number' && Number.isFinite(body.lexical_weight) && body.lexical_weight >= 0
      ? body.lexical_weight : DEFAULT_SEARCH_CONFIG.lexical_weight;
    const mmr_lambda = typeof body.mmr_lambda === 'number' && Number.isFinite(body.mmr_lambda) && body.mmr_lambda >= 0 && body.mmr_lambda <= 1
      ? body.mmr_lambda : DEFAULT_SEARCH_CONFIG.mmr_lambda;
    const mmr_pool_size = Number.isInteger(body.mmr_pool_size) && body.mmr_pool_size > 0
      ? body.mmr_pool_size : DEFAULT_SEARCH_CONFIG.mmr_pool_size;
    const mmr_output_size = Number.isInteger(body.mmr_output_size) && body.mmr_output_size > 0
      ? body.mmr_output_size : DEFAULT_SEARCH_CONFIG.mmr_output_size;
    const rerank_lexical = typeof body.rerank_lexical === 'number' && Number.isFinite(body.rerank_lexical) && body.rerank_lexical >= 0
      ? body.rerank_lexical : DEFAULT_SEARCH_CONFIG.rerank_lexical;
    const rerank_fuzzy = typeof body.rerank_fuzzy === 'number' && Number.isFinite(body.rerank_fuzzy) && body.rerank_fuzzy >= 0
      ? body.rerank_fuzzy : DEFAULT_SEARCH_CONFIG.rerank_fuzzy;
    const rerank_rrf = typeof body.rerank_rrf === 'number' && Number.isFinite(body.rerank_rrf) && body.rerank_rrf >= 0
      ? body.rerank_rrf : DEFAULT_SEARCH_CONFIG.rerank_rrf;
    const rerank_entity = typeof body.rerank_entity === 'number' && Number.isFinite(body.rerank_entity) && body.rerank_entity >= 0
      ? body.rerank_entity : DEFAULT_SEARCH_CONFIG.rerank_entity;
    const semantic_enabled = typeof body.semantic_enabled === 'boolean'
      ? body.semantic_enabled : DEFAULT_SEARCH_CONFIG.semantic_enabled;

    const pool = requireNativeDatabase();
    await pool.query(
      `INSERT INTO public.verity_search_config (
         id, rrf_k, semantic_weight, lexical_weight, mmr_lambda, mmr_pool_size,
         mmr_output_size, rerank_lexical, rerank_fuzzy, rerank_rrf, rerank_entity,
         semantic_enabled, updated_at, updated_by
       ) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12)
       ON CONFLICT (id) DO UPDATE SET
         rrf_k = EXCLUDED.rrf_k,
         semantic_weight = EXCLUDED.semantic_weight,
         lexical_weight = EXCLUDED.lexical_weight,
         mmr_lambda = EXCLUDED.mmr_lambda,
         mmr_pool_size = EXCLUDED.mmr_pool_size,
         mmr_output_size = EXCLUDED.mmr_output_size,
         rerank_lexical = EXCLUDED.rerank_lexical,
         rerank_fuzzy = EXCLUDED.rerank_fuzzy,
         rerank_rrf = EXCLUDED.rerank_rrf,
         rerank_entity = EXCLUDED.rerank_entity,
         semantic_enabled = EXCLUDED.semantic_enabled,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [
        rrf_k, semantic_weight, lexical_weight, mmr_lambda, mmr_pool_size,
        mmr_output_size, rerank_lexical, rerank_fuzzy, rerank_rrf, rerank_entity,
        semantic_enabled, context.user.id,
      ]
    );

    clearSearchConfigCache();
    const data: SearchConfig = {
      rrf_k, semantic_weight, lexical_weight, mmr_lambda, mmr_pool_size,
      mmr_output_size, rerank_lexical, rerank_fuzzy, rerank_rrf, rerank_entity,
      semantic_enabled,
    };
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
