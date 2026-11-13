import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import {
  getDedupWorkbenchSummary,
  listDedupClusters,
  rebuildDedupClusters,
  DEDUP_CLUSTER_BUILD_VERSION,
  type DedupClusterListOptions,
} from '@/lib/server/dedup-clusters';
import type { DedupTier } from '@/types/dedup';

export const dynamic = 'force-dynamic';

function boundedInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 0), max) : fallback;
}

export async function GET(request: NextRequest) {
  try {
    await requireNativeReviewer();
    const params = request.nextUrl.searchParams;
    const rawStatus = params.get('status') || 'open';
    const rawTier = params.get('tier') || undefined;
    const rawScope = params.get('scope') || 'all';
    if (!['open', 'resolved', 'dismissed'].includes(rawStatus)) throw new ApiError(400, 'INVALID_STATUS', 'Trạng thái cluster không hợp lệ.');
    if (rawTier && !['exact', 'near', 'similar'].includes(rawTier)) throw new ApiError(400, 'INVALID_TIER', 'Tầng duplicate không hợp lệ.');
    if (!['all', 'duplicates', 'similar'].includes(rawScope)) throw new ApiError(400, 'INVALID_SCOPE', 'Nhóm hiển thị không hợp lệ.');
    if (rawScope === 'duplicates' && rawTier === 'similar') throw new ApiError(400, 'INVALID_TIER', 'Ảnh tương tự nằm trong không gian so sánh riêng.');
    const options: DedupClusterListOptions = {
      status: rawStatus as DedupClusterListOptions['status'],
      tier: rawScope === 'similar' ? 'similar' : rawTier as DedupTier | undefined,
      tiers: rawScope === 'duplicates' && !rawTier ? ['exact', 'near'] : undefined,
      limit: Math.max(1, boundedInt(params.get('limit'), 25, 100)),
      offset: boundedInt(params.get('offset'), 0, 10_000),
    };
    const pool = requireNativeDatabase();
    const evidence = await pool.query<{ latest_evidence: string | null; latest_cluster: string | null; oldest_open_build_version: string | null }>(
      `select (select max(created_at) from public.media_dedup_matches) as latest_evidence,
              (select max(updated_at) from public.media_dedup_clusters) as latest_cluster,
              (select min(build_version)::text from public.media_dedup_clusters where status='open') as oldest_open_build_version`,
    );
    const evidenceAt = evidence.rows[0]?.latest_evidence ? Date.parse(evidence.rows[0].latest_evidence) : 0;
    const clusterAt = evidence.rows[0]?.latest_cluster ? Date.parse(evidence.rows[0].latest_cluster) : 0;
    const oldestOpenBuildVersion = Number(evidence.rows[0]?.oldest_open_build_version || DEDUP_CLUSTER_BUILD_VERSION);
    const needsRebuild = evidenceAt > clusterAt || oldestOpenBuildVersion < DEDUP_CLUSTER_BUILD_VERSION;
    if (needsRebuild) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await rebuildDedupClusters(client);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        // Never serve a stale materialized interpretation to a cleanup UI.
        // Evidence remains durable; a reviewer can retry after the builder is healthy.
        throw new ApiError(503, 'DEDUP_REBUILD_REQUIRED', 'Không thể làm mới nhóm ảnh an toàn. Vui lòng thử quét lại sau.');
      } finally { client.release(); }
    }
    const [list, summary] = await Promise.all([
      listDedupClusters(pool, options),
      getDedupWorkbenchSummary(pool),
    ]);
    return NextResponse.json({ success: true, data: { ...list, ...summary } });
  } catch (error) {
    return errorResponse(error);
  }
}
