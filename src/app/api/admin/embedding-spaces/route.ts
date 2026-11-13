import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

/** Batch 5: read-only observability for the staged SigLIP2 versioned-space
 * migration (backend/migrations/0022_siglip2_versioned_space_schema.sql --
 * committed as "stage Phase 5A/5B/5C/6/7A versioned-space migration, not
 * merged, not deployed"). This endpoint has NO write path and never will:
 * cutover is `public.transition_runtime_spaces(...)`, a SECURITY DEFINER
 * function with `REVOKE ALL ... FROM PUBLIC` and EXECUTE granted only to
 * the verity_operator DB role -- the web app's own DB role has no privilege
 * to call it, by design. The separate, older Settings -> AI Embedding page
 * (EmbeddingSettings.tsx / api/settings/embedding) configures per-provider
 * API keys for the *existing* embedding calls and is untouched by this
 * batch; it must never be confused with, or turned into, a cutover control.
 *
 * schema_ready=false is an expected, common state (this migration may not
 * be applied in every environment yet) -- not an error. */
export async function GET() {
  try {
    await requireNativeAdmin();
    const pool = requireNativeDatabase();

    const schema = await pool.query<{ spaces_table: string | null; state_table: string | null }>(
      `select to_regclass('public.embedding_spaces')::text as spaces_table,
              to_regclass('public.embedding_runtime_state')::text as state_table`
    );
    const schemaReady = Boolean(schema.rows[0]?.spaces_table && schema.rows[0]?.state_table);

    if (!schemaReady) {
      return NextResponse.json({
        schema_ready: false,
        spaces: [],
        runtime_state: null,
        total_assets: 0,
        checked_at: new Date().toISOString(),
      });
    }

    const [spaces, runtimeState, calibration, coverage, totalAssets] = await Promise.all([
      pool.query<{
        space_id: string; model_family: string; model_name: string; model_revision: string | null;
        dimension: number; distance_metric: string; provider: string; runtime: string; status: string;
        created_at: string; activated_at: string | null;
      }>(
        `select space_id, model_family, model_name, model_revision, dimension, distance_metric, provider, runtime, status, created_at, activated_at
           from public.embedding_spaces
          order by (status = 'ACTIVE') desc, created_at asc`
      ),
      pool.query<{ active_space_id: string; nl_search_space_id: string | null; updated_at: string }>(
        `select active_space_id, nl_search_space_id, updated_at from public.embedding_runtime_state where singleton_id = 1`
      ),
      pool.query<{
        space_id: string; sku_high: number; sku_low: number; ambiguity_margin: number;
        consistency_primary_min: number; consistency_spread_max: number; scene_duplicate_threshold: number;
      }>(
        `select space_id, sku_high, sku_low, ambiguity_margin, consistency_primary_min, consistency_spread_max, scene_duplicate_threshold
           from public.embedding_space_calibration`
      ),
      // 'global' is the whole-image embedding kind (one per asset per space,
      // per uq_asset_embeddings_global) -- the meaningful "has this asset
      // been backfilled into this space" signal. product_crop/scene_region
      // rows are a different, per-region concept, not asset-level coverage.
      pool.query<{ space_id: string; asset_count: number }>(
        `select space_id, count(distinct asset_id)::int as asset_count
           from public.asset_embeddings where kind = 'global' group by space_id`
      ),
      pool.query<{ count: number }>(`select count(*)::int as count from public.media_assets where deleted_at is null`),
    ]);

    const calibrationBySpace = new Map(calibration.rows.map((row) => [row.space_id, row]));
    const coverageBySpace = new Map(coverage.rows.map((row) => [row.space_id, row.asset_count]));
    const totalAssetCount = totalAssets.rows[0]?.count || 0;

    return NextResponse.json({
      schema_ready: true,
      spaces: spaces.rows.map((row) => {
        const assetEmbeddingCount = coverageBySpace.get(row.space_id) || 0;
        return {
          ...row,
          calibration: calibrationBySpace.get(row.space_id) || null,
          asset_embedding_count: assetEmbeddingCount,
          coverage_pct: totalAssetCount > 0 ? Math.round((assetEmbeddingCount / totalAssetCount) * 1000) / 10 : 0,
        };
      }),
      runtime_state: runtimeState.rows[0] || null,
      total_assets: totalAssetCount,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
