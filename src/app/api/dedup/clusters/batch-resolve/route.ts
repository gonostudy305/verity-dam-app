import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { resolveDedupCluster, type ClusterResolveResolution } from '@/lib/server/cluster-resolve';
import { assertBatchResolutionAllowed, parseBatchResolveRequestBody } from '@/lib/server/dedup-route-contracts';
import type { BatchResolveReport } from '@/types/dedup';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeReviewer();
    const body = await request.json().catch(() => { throw new ApiError(400, 'INVALID_BODY', 'Body phải là JSON hợp lệ.'); });
    const parsed = parseBatchResolveRequestBody(body);
    const ids = parsed.cluster_ids;
    const resolution = parsed.resolution as ClusterResolveResolution;
    // Batch selection has no per-asset review step. It must never infer a
    // removal set from a cluster, even when the evidence tier is exact.
    assertBatchResolutionAllowed(resolution);
    const pool = requireNativeDatabase();
    const tierRows = await pool.query<{ id: string }>(`select id from public.media_dedup_clusters where id=any($1::uuid[]) and status='open'`, [ids]);
    const byId = new Map(tierRows.rows.map((row) => [row.id, row]));
    const report: BatchResolveReport = { resolved: [], skipped: [], removed_asset_ids: [], total_reclaimed_bytes: 0 };
    for (const clusterId of ids) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const row = byId.get(clusterId);
        if (!row) throw new ApiError(409, 'CLUSTER_NOT_OPEN', 'Cluster không còn mở hoặc không tồn tại.');
        const data = await resolveDedupCluster(client, clusterId, user.id, {
          resolution,
          forceConfirm: false,
        });
        await client.query('commit');
        report.resolved.push({ cluster_id: clusterId, removed_asset_ids: data.removedAssetIds, reclaimed_bytes: data.reclaimedBytes });
        report.removed_asset_ids.push(...data.removedAssetIds);
        report.total_reclaimed_bytes += data.reclaimedBytes;
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        if (error instanceof ApiError) report.skipped.push({ cluster_id: clusterId, code: error.code, protected: Array.isArray(error.details) ? error.details : undefined });
        else report.skipped.push({ cluster_id: clusterId, code: 'INTERNAL_ERROR' });
      } finally { client.release(); }
    }
    return NextResponse.json({ success: true, data: report });
  } catch (error) { return errorResponse(error); }
}
