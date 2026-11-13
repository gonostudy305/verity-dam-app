import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { resolveDedupCluster } from '@/lib/server/cluster-resolve';
import { parseResolveRequestBody } from '@/lib/server/dedup-route-contracts';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user } = await requireNativeReviewer();
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID cluster không hợp lệ.');
    const body = await request.json().catch(() => { throw new ApiError(400, 'INVALID_BODY', 'Body phải là JSON hợp lệ.'); });
    const input = parseResolveRequestBody(body);
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      const data = await resolveDedupCluster(client, id, user.id, input);
      await client.query('commit');
      return NextResponse.json({ success: true, data: {
        cluster_id: data.clusterId,
        resolution: data.resolution,
        removed_asset_ids: data.removedAssetIds,
        cancelled_jobs: data.softDelete.cancelledJobs,
        cleaned_duplicate_queues: data.softDelete.cleanedDuplicateQueues,
        suppressed_pairs: data.suppressedPairs,
        reclaimed_bytes: data.reclaimedBytes,
        undo_available: data.undoAvailable,
      } });
    } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
    finally { client.release(); }
  } catch (error) { return errorResponse(error); }
}
