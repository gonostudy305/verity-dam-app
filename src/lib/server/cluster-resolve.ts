import type { PoolClient } from 'pg';

import { DEDUP_CLUSTER_BUILD_VERSION } from './dedup-clusters';
import { ApiError } from './http';
import { softDeleteMediaAssets } from './media-soft-delete';

export type ClusterResolveResolution = 'keep_one' | 'keep_all' | 'not_duplicate';

export interface ClusterResolveInput {
  resolution: ClusterResolveResolution;
  keepAssetId?: string;
  removeAssetIds?: string[];
  forceConfirm?: boolean;
  note?: string;
}

export interface ProtectionReport {
  id: string;
  title: string;
  usage_count: number;
  has_usage: boolean;
  publish_status: string;
  published_at: string | null;
  reasons: Array<'in_use' | 'published'>;
}

export function protectionReasons(row: { usage_count: number; has_usage: boolean; publish_status: string; published_at: string | null }): Array<'in_use' | 'published'> {
  const reasons: Array<'in_use' | 'published'> = [];
  if (Number(row.usage_count) > 0 || row.has_usage) reasons.push('in_use');
  if (row.publish_status === 'published' || row.published_at) reasons.push('published');
  return reasons;
}

export function buildResolveEventPayload(input: ClusterResolveInput, keepAssetId: string | null, removeAssetIds: string[], protection: ProtectionReport[]) {
  return {
    resolution: input.resolution,
    keep_asset_id: keepAssetId,
    remove_asset_ids: removeAssetIds,
    forced: Boolean(input.forceConfirm),
    protection,
    note: input.note || null,
  };
}

export function normalizedRemoveIds(memberIds: string[], input: ClusterResolveInput): { keepId: string | null; removeIds: string[] } {
  const memberSet = new Set(memberIds);
  if (!['keep_one', 'keep_all', 'not_duplicate'].includes(input.resolution)) throw new ApiError(400, 'INVALID_RESOLUTION', 'Resolution không hợp lệ.');
  if (input.resolution === 'keep_one') {
    if (!input.keepAssetId || !memberSet.has(input.keepAssetId)) throw new ApiError(400, 'NOT_A_CLUSTER_MEMBER', 'Asset giữ lại không thuộc cluster.');
    const removeIds = [...new Set(input.removeAssetIds || [])];
    if (removeIds.some((id) => !memberSet.has(id))) throw new ApiError(400, 'NOT_A_CLUSTER_MEMBER', 'Asset cần xoá không thuộc cluster.');
    if (removeIds.includes(input.keepAssetId)) throw new ApiError(400, 'CONFLICTING_SELECTION', 'Không thể vừa giữ vừa xoá cùng một asset.');
    if (!removeIds.length) throw new ApiError(400, 'CANNOT_REMOVE_ALL', 'Cluster phải còn ít nhất một asset được giữ.');
    return { keepId: input.keepAssetId, removeIds };
  }
  if (input.keepAssetId || (input.removeAssetIds && input.removeAssetIds.length)) throw new ApiError(400, 'CONFLICTING_SELECTION', 'Keep/remove chỉ dùng cho resolution keep_one.');
  return { keepId: null, removeIds: [] };
}

export async function suppressClusterPairs(client: PoolClient, clusterId: string, memberIds: string[], actorId: string, note?: string) {
  const result = await client.query(
    `insert into public.media_dedup_pair_suppressions(asset_min_id, asset_max_id, cluster_id, suppressed_by, note)
     select case when left_id < right_id then left_id else right_id end,
            case when left_id < right_id then right_id else left_id end,
            $1, $2, $3
       from unnest($4::uuid[]) as left_id cross join unnest($4::uuid[]) as right_id
      where left_id < right_id
     on conflict (asset_min_id, asset_max_id) do nothing`,
    [clusterId, actorId, note || null, memberIds],
  );
  return result.rowCount || 0;
}

export async function getClusterProtectionReport(client: PoolClient, assetIds: string[]): Promise<ProtectionReport[]> {
  if (!assetIds.length) return [];
  const result = await client.query<{ id: string; title: string; usage_count: number; has_usage: boolean; publish_status: string; published_at: string | null }>(
    `select a.id, a.title, coalesce(a.usage_count,0) as usage_count,
            exists(select 1 from public.media_usages u where u.media_asset_id=a.id) as has_usage,
            a.publish_status, a.published_at
       from public.media_assets a where a.id=any($1::uuid[]) for update`, [assetIds],
  );
  return result.rows.map((row) => ({ ...row, reasons: protectionReasons(row) })).filter((row) => row.reasons.length > 0);
}

export async function resolveDedupCluster(client: PoolClient, clusterId: string, actorId: string, input: ClusterResolveInput) {
  const cluster = await client.query<{ id: string; status: string; tier: string; build_version: number; canonical_media_asset_id: string | null }>(
    `select id, status, tier, build_version, canonical_media_asset_id from public.media_dedup_clusters where id=$1 for update`, [clusterId],
  );
  if (!cluster.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Không tìm thấy cluster.');
  if (cluster.rows[0].status !== 'open') throw new ApiError(409, 'CLUSTER_NOT_OPEN', 'Cluster này đã được xử lý.');
  if (Number(cluster.rows[0].build_version) < DEDUP_CLUSTER_BUILD_VERSION) {
    throw new ApiError(409, 'CLUSTER_REBUILD_REQUIRED', 'Nhóm ảnh đang dùng cách phân cụm cũ và cần quét lại trước khi xử lý.');
  }
  if (cluster.rows[0].tier === 'similar' && input.resolution === 'keep_one') {
    throw new ApiError(409, 'SIMILAR_CANNOT_REMOVE', 'Ảnh tương tự chỉ dùng để so sánh; không thể đưa vào thùng rác từ nhóm này.');
  }
  const members = await client.query<{ media_asset_id: string }>(
    `select media_asset_id from public.media_dedup_cluster_members where cluster_id=$1 order by media_asset_id for update`, [clusterId],
  );
  if (members.rows.length < 2) throw new ApiError(409, 'CANNOT_REMOVE_ALL', 'Cluster không đủ member để xử lý.');
  const memberIds = members.rows.map((row) => row.media_asset_id);
  const { keepId, removeIds } = normalizedRemoveIds(memberIds, input);
  const protection = await getClusterProtectionReport(client, removeIds);
  if (protection.length && !input.forceConfirm) {
    throw new ApiError(409, 'PROTECTED_ASSETS', 'Một hoặc nhiều asset đang được sử dụng hoặc đã xuất bản.', protection);
  }
  let softDelete = { deleted: 0, alreadyDeleted: 0, cancelledJobs: 0, cleanedDuplicateQueues: 0, deletedAtById: {}, deletedByById: {} };
  if (input.resolution === 'keep_one') {
    softDelete = await softDeleteMediaAssets(client, removeIds, actorId, 'Asset soft-deleted after duplicate cluster resolution');
  }
  const suppressedPairs = input.resolution === 'not_duplicate'
    ? await suppressClusterPairs(client, clusterId, memberIds, actorId, input.note)
    : 0;
  const decision = input.resolution === 'keep_one' ? `case when media_asset_id=$2 then 'keep' when media_asset_id=any($3::uuid[]) then 'remove' else 'undecided' end` : `'undecided'`;
  await client.query(
    `update public.media_dedup_cluster_members set decision=${decision} where cluster_id=$1`,
    input.resolution === 'keep_one' ? [clusterId, keepId, removeIds] : [clusterId],
  );
  const status = input.resolution === 'not_duplicate' ? 'dismissed' : 'resolved';
  await client.query(
    `update public.media_dedup_clusters
        set status=$2, resolution=$3, canonical_media_asset_id=coalesce($4::uuid, canonical_media_asset_id),
            resolved_by=$5, resolved_at=now(), updated_at=now()
      where id=$1`, [clusterId, status, input.resolution, keepId, actorId],
  );
  const payload = buildResolveEventPayload(input, keepId, removeIds, protection);
  await client.query(
    `insert into public.media_dedup_cluster_events(cluster_id, action, payload, actor_id) values ($1,$2,$3::jsonb,$4)`,
    [clusterId, input.resolution === 'not_duplicate' ? 'dismissed' : 'resolved', JSON.stringify(payload), actorId],
  );
  const reclaimedBytes = input.resolution === 'keep_one' ? Number((await client.query<{ bytes: string }>(`select coalesce(sum((dimensions->>'size_bytes')::bigint),0)::text as bytes from public.media_assets where id=any($1::uuid[])`, [removeIds])).rows[0]?.bytes || 0) : 0;
  return { clusterId, resolution: input.resolution, removedAssetIds: removeIds, softDelete, suppressedPairs, reclaimedBytes, undoAvailable: true };
}
