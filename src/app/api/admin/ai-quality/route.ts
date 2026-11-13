import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { resolveMediaUrls } from '@/lib/server/native-media';

export const dynamic = 'force-dynamic';

/** Batch 6: read-only observability for the AI correction/learning loop.
 * review_correction_log and metadata_few_shot_examples (both in
 * 0003_native_media_schema.sql) are written by review-queue/[id]/decision
 * on every approved SKU/metadata correction but had no reader anywhere in
 * this repo before this endpoint -- structurally the same "write-only audit
 * table" gap Batch 3 fixed for media_asset_products.
 *
 * sku_references (0022_siglip2_versioned_space_schema.sql) is the newer
 * "generalized" reference table that decision/route.ts's SKU auto-enrich
 * path now writes to going forward. It is deliberately NOT the same table
 * as the legacy public.sku_reference_embeddings / sku_reference_embeddings_shadow
 * that backend/app/native_gateway.py's matching pipeline still reads/writes
 * independently -- reconciling those is an embedding-architecture question
 * (out of scope here, per the standing "don't touch embedding/search
 * architecture" constraint). This endpoint only reports sku_references,
 * and checks its presence via to_regclass the same way Batch 5's
 * embedding-spaces endpoint does, since 0022 may not be applied in every
 * environment.
 *
 * No write path exists or is planned here -- curation_status/match_eligible
 * mutation would touch the live matching pipeline and is out of scope. */
export async function GET() {
  try {
    await requireNativeAdmin();
    const pool = requireNativeDatabase();

    const schema = await pool.query<{ sku_references_table: string | null }>(
      `select to_regclass('public.sku_references')::text as sku_references_table`
    );
    const skuReferencesReady = Boolean(schema.rows[0]?.sku_references_table);

    const [
      correctionsByKind,
      recentCorrections,
      fewShotCounts,
      recentFewShot,
      skuCurationByStatus,
      skuCurationFlags,
      skuReferenceBreakdown,
    ] = await Promise.all([
      pool.query<{ correction_kind: string; count: number }>(
        `select correction_kind, count(*)::int as count from public.review_correction_log group by correction_kind`
      ),
      pool.query<{
        id: string; media_asset_id: string; correction_kind: string; fields: unknown;
        reviewed_by: string | null; reviewed_by_email: string | null; created_at: string;
        title: string | null; sku: string | null; storage_path: string | null; thumbnail_path: string | null;
      }>(
        `select l.id, l.media_asset_id, l.correction_kind, l.fields, l.reviewed_by, u.email as reviewed_by_email,
                l.created_at, a.title, a.sku, a.storage_path, a.thumbnail_path
           from public.review_correction_log l
           left join public."user" u on u.id = l.reviewed_by
           left join public.media_assets a on a.id = l.media_asset_id
          order by l.created_at desc
          limit 20`
      ),
      pool.query<{ total: number; active: number }>(
        `select count(*)::int as total, count(*) filter (where is_active)::int as active
           from public.metadata_few_shot_examples`
      ),
      pool.query<{
        id: string; source_media_asset_id: string; is_active: boolean; created_at: string;
        title: string | null; sku: string | null; storage_path: string | null; thumbnail_path: string | null;
      }>(
        `select f.id, f.source_media_asset_id, f.is_active, f.created_at, a.title, a.sku, a.storage_path, a.thumbnail_path
           from public.metadata_few_shot_examples f
           left join public.media_assets a on a.id = f.source_media_asset_id
          order by f.created_at desc
          limit 10`
      ),
      skuReferencesReady
        ? pool.query<{ curation_status: string; count: number }>(
            `select curation_status, count(*)::int as count from public.sku_references group by curation_status`
          )
        : Promise.resolve({ rows: [] as { curation_status: string; count: number }[] }),
      skuReferencesReady
        ? pool.query<{
            total: number; match_eligible: number; not_match_eligible: number;
            active: number; frozen_benchmark: number; avg_quality_score: number | null;
          }>(
            `select count(*)::int as total,
                    count(*) filter (where match_eligible)::int as match_eligible,
                    count(*) filter (where not match_eligible)::int as not_match_eligible,
                    count(*) filter (where is_active)::int as active,
                    count(*) filter (where is_frozen_benchmark)::int as frozen_benchmark,
                    avg(quality_score) as avg_quality_score
               from public.sku_references`
          )
        : Promise.resolve({ rows: [{ total: 0, match_eligible: 0, not_match_eligible: 0, active: 0, frozen_benchmark: 0, avg_quality_score: null }] }),
      skuReferencesReady
        ? pool.query<{
            image_category: string; reference_role: string; match_eligible: boolean; category: string; count: number;
          }>(
            `select coalesce(r.image_category, 'STUDIO') as image_category,
                    coalesce(r.reference_role, 'UNCLASSIFIED') as reference_role,
                    r.match_eligible,
                    coalesce(a.category, 'Unknown') as category,
                    count(*)::int as count
               from public.sku_references r
               left join public.media_assets a on a.id = r.source_media_asset_id
              group by coalesce(r.image_category, 'STUDIO'), coalesce(r.reference_role, 'UNCLASSIFIED'), r.match_eligible, coalesce(a.category, 'Unknown')
              order by count desc`
          )
        : Promise.resolve({ rows: [] as { image_category: string; reference_role: string; match_eligible: boolean; category: string; count: number }[] }),
    ]);

    const correctionRows = [...recentCorrections.rows, ...recentFewShot.rows];
    const urls = resolveMediaUrls(correctionRows);

    const kindCounts = { sku: 0, metadata: 0 } as Record<string, number>;
    for (const row of correctionsByKind.rows) {
      kindCounts[row.correction_kind] = row.count;
    }

    return NextResponse.json({
      corrections: {
        by_kind: kindCounts,
        recent: recentCorrections.rows.map((row) => ({
          id: row.id,
          media_asset_id: row.media_asset_id,
          correction_kind: row.correction_kind,
          fields: row.fields,
          reviewed_by_email: row.reviewed_by_email,
          created_at: row.created_at,
          asset_title: row.title,
          asset_sku: row.sku,
          thumbnail_url: row.thumbnail_path ? urls.get(row.thumbnail_path) || urls.get(row.storage_path || '') || '' : urls.get(row.storage_path || '') || '',
        })),
      },
      few_shot: {
        total: fewShotCounts.rows[0]?.total || 0,
        active: fewShotCounts.rows[0]?.active || 0,
        recent: recentFewShot.rows.map((row) => ({
          id: row.id,
          source_media_asset_id: row.source_media_asset_id,
          is_active: row.is_active,
          created_at: row.created_at,
          asset_title: row.title,
          asset_sku: row.sku,
          thumbnail_url: row.thumbnail_path ? urls.get(row.thumbnail_path) || urls.get(row.storage_path || '') || '' : urls.get(row.storage_path || '') || '',
        })),
      },
      sku_curation: {
        schema_ready: skuReferencesReady,
        total: skuCurationFlags.rows[0]?.total || 0,
        match_eligible: skuCurationFlags.rows[0]?.match_eligible || 0,
        not_match_eligible: skuCurationFlags.rows[0]?.not_match_eligible || 0,
        active: skuCurationFlags.rows[0]?.active || 0,
        frozen_benchmark: skuCurationFlags.rows[0]?.frozen_benchmark || 0,
        avg_quality_score: skuCurationFlags.rows[0]?.avg_quality_score !== null && skuCurationFlags.rows[0]?.avg_quality_score !== undefined
          ? Math.round(Number(skuCurationFlags.rows[0].avg_quality_score) * 10) / 10
          : null,
        by_status: skuCurationByStatus.rows.reduce<Record<string, number>>((acc, row) => {
          acc[row.curation_status] = row.count;
          return acc;
        }, {}),
        breakdown: skuReferenceBreakdown.rows,
      },
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
