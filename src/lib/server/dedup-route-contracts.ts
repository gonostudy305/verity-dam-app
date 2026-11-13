import { isUuid } from '@/lib/media-api';
import { ApiError } from './http';
import type { BatchResolveInput } from '@/types/dedup';
import type { ClusterResolveInput } from './cluster-resolve';

function recordBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', 'Body phải là object JSON hợp lệ.');
  return body as Record<string, unknown>;
}

export function parseResolveRequestBody(body: unknown): ClusterResolveInput {
  const value = recordBody(body);
  const allowed = new Set(['resolution', 'keep_asset_id', 'remove_asset_ids', 'force_confirm', 'note']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ApiError(400, 'INVALID_BODY', 'Body chứa field không được hỗ trợ.');
  if (Object.prototype.hasOwnProperty.call(value, 'remove_asset_ids') && !Array.isArray(value.remove_asset_ids)) throw new ApiError(400, 'INVALID_BODY', 'remove_asset_ids phải là một mảng UUID.');
  if (Object.prototype.hasOwnProperty.call(value, 'keep_asset_id') && typeof value.keep_asset_id !== 'string') throw new ApiError(400, 'INVALID_BODY', 'keep_asset_id phải là UUID.');
  if (Object.prototype.hasOwnProperty.call(value, 'force_confirm') && typeof value.force_confirm !== 'boolean') throw new ApiError(400, 'INVALID_BODY', 'force_confirm phải là boolean.');
  if (Object.prototype.hasOwnProperty.call(value, 'note') && typeof value.note !== 'string') throw new ApiError(400, 'INVALID_BODY', 'note phải là chuỗi.');
  const rawRemoveIds = Array.isArray(value.remove_asset_ids) ? value.remove_asset_ids : undefined;
  if (rawRemoveIds?.some((id) => typeof id !== 'string' || !isUuid(id))) throw new ApiError(400, 'INVALID_BODY', 'remove_asset_ids chứa UUID không hợp lệ.');
  const removeAssetIds = rawRemoveIds ? [...new Set(rawRemoveIds as string[])] : undefined;
  const resolution = value.resolution;
  if (!['keep_one', 'keep_all', 'not_duplicate'].includes(String(resolution))) throw new ApiError(400, 'INVALID_RESOLUTION', 'Resolution không hợp lệ.');
  const keepAssetId = typeof value.keep_asset_id === 'string' ? value.keep_asset_id : undefined;
  if (keepAssetId && !isUuid(keepAssetId)) throw new ApiError(400, 'INVALID_BODY', 'keep_asset_id không hợp lệ.');
  if (resolution === 'keep_one' && (!keepAssetId || !removeAssetIds?.length)) throw new ApiError(400, 'INVALID_BODY', 'keep_one cần keep_asset_id và ít nhất một remove_asset_id.');
  return {
    resolution: resolution as ClusterResolveInput['resolution'],
    keepAssetId,
    removeAssetIds,
    forceConfirm: value.force_confirm === true,
    note: typeof value.note === 'string' ? value.note.trim().slice(0, 500) : undefined,
  };
}

export function parseBatchResolveRequestBody(body: unknown): BatchResolveInput {
  const value = recordBody(body);
  const allowed = new Set(['cluster_ids', 'resolution']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ApiError(400, 'INVALID_BODY', 'Body batch không hợp lệ.');
  const rawIds = Array.isArray(value.cluster_ids) ? value.cluster_ids : [];
  if (rawIds.some((id) => typeof id !== 'string' || !isUuid(id))) throw new ApiError(400, 'INVALID_BODY', 'cluster_ids chứa UUID không hợp lệ.');
  const clusterIds = [...new Set(rawIds as string[])];
  if (!clusterIds.length) throw new ApiError(400, 'NO_IDS', 'Cần chọn ít nhất một cluster.');
  if (clusterIds.length > 25) throw new ApiError(400, 'TOO_MANY_CLUSTERS', 'Batch tối đa 25 cluster.');
  if (!['keep_one', 'keep_all', 'not_duplicate'].includes(String(value.resolution))) throw new ApiError(400, 'INVALID_RESOLUTION', 'Resolution không hợp lệ.');
  return { cluster_ids: clusterIds, resolution: value.resolution as BatchResolveInput['resolution'] };
}

/** Batch mode has no per-asset selection, so it can only record safe decisions. */
export function assertBatchResolutionAllowed(resolution: BatchResolveInput['resolution']) {
  if (resolution === 'keep_one') {
    throw new ApiError(409, 'BULK_KEEP_ONE_DISABLED', 'Dọn ảnh cần mở từng nhóm và chọn rõ ảnh đưa vào thùng rác.');
  }
}
