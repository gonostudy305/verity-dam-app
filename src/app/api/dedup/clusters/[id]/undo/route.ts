import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { restoreMediaAssets } from '@/lib/server/media-soft-delete';
import { getLatestClusterResolutionEvent, reopenCluster } from '@/lib/server/dedup-clusters';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user } = await requireNativeReviewer();
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID cluster không hợp lệ.');
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      const cluster = await client.query<{ id: string; status: string }>(
        `select id, status from public.media_dedup_clusters where id=$1 for update`, [id],
      );
      if (!cluster.rows[0]) throw notFound();
      if (!['resolved', 'dismissed'].includes(cluster.rows[0].status)) throw new ApiError(409, 'CLUSTER_NOT_RESOLVED', 'Cluster chưa ở trạng thái đã xử lý để hoàn tác.');
      const event = await getLatestClusterResolutionEvent(client, id);
      if (!event) throw new ApiError(409, 'CLUSTER_EVENT_MISSING', 'Cluster không có event resolve hợp lệ để hoàn tác.');
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : typeof event.payload === 'string'
          ? (() => { try { const parsed = JSON.parse(event.payload); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } })()
          : {};
      const removeIds = Array.isArray(payload.remove_asset_ids) ? payload.remove_asset_ids.filter((id): id is string => typeof id === 'string') : [];
      if (removeIds.length) {
        const existing = await client.query<{ id: string }>(`select id from public.media_assets where id=any($1::uuid[])`, [removeIds]);
        if (existing.rowCount !== removeIds.length) throw new ApiError(409, 'CLUSTER_UNDO_PURGED', 'Không thể hoàn tác vì một asset trong cluster đã bị purge vĩnh viễn.');
      }
      // Undo restores the soft-deleted asset rows only. Ingest jobs cancelled
      // by the original resolve stay cancelled; replaying them is a separate
      // explicit worker operation and must never happen implicitly here.
      const restored = await restoreMediaAssets(client, removeIds, user.id);
      await client.query(`update public.media_dedup_cluster_members set decision='undecided' where cluster_id=$1`, [id]);
      if (!await reopenCluster(client, id)) throw new ApiError(409, 'CLUSTER_NOT_RESOLVED', 'Cluster không còn ở trạng thái đã xử lý để hoàn tác.');
      await client.query(`delete from public.media_dedup_pair_suppressions where cluster_id=$1`, [id]);
      await client.query(
        `insert into public.media_dedup_cluster_events(cluster_id, action, payload, actor_id) values ($1,'undone',$2::jsonb,$3)`,
        [id, JSON.stringify({ restored_asset_ids: removeIds }), user.id],
      );
      await client.query('commit');
      return NextResponse.json({ success: true, data: { cluster_id: id, restored } });
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  } catch (error) { return errorResponse(error); }
}
