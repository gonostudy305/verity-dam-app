import type { PoolClient } from 'pg';
import { notFound } from './http';

export function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

export interface SoftDeleteResult {
  deleted: number;
  alreadyDeleted: number;
  cancelledJobs: number;
  cleanedDuplicateQueues: number;
  deletedAtById: Record<string, string | null>;
  deletedByById: Record<string, string | null>;
}

/**
 * Soft-delete assets inside the caller's transaction. This deliberately keeps
 * R2 objects intact and preserves the existing review-queue cleanup semantics
 * used by DELETE /api/media/[id].
 */
export async function softDeleteMediaAssets(client: PoolClient, assetIds: string[], actorId: string, reason = 'Asset soft-deleted by reviewer'): Promise<SoftDeleteResult> {
  const ids = [...new Set(assetIds)];
  if (!ids.length) return { deleted: 0, alreadyDeleted: 0, cancelledJobs: 0, cleanedDuplicateQueues: 0, deletedAtById: {}, deletedByById: {} };
  const assets = await client.query<{ id: string; deleted_at: string | null; deleted_by: string | null }>(
    `select id, deleted_at, deleted_by from public.media_assets where id = any($1::uuid[]) for update`, [ids],
  );
  const foundIds = assets.rows.map((row) => row.id);
  const foundSet = new Set(foundIds);
  const missing = ids.filter((id) => !foundSet.has(id));
  if (missing.length) throw notFound('Không tìm thấy tệp media.');
  const updated = await client.query<{ id: string; deleted_at: string; deleted_by: string }>(
    `update public.media_assets
        set deleted_at = coalesce(deleted_at, now()),
            deleted_by = coalesce(deleted_by, $2::uuid),
            updated_at = now()
      where id = any($1::uuid[])
      returning id, deleted_at, deleted_by`, [ids, actorId],
  );
  const cancelled = await client.query(
    `update public.media_ingest_jobs
        set status = 'cancelled', locked_at = null, locked_by = null,
            completed_at = coalesce(completed_at, now()),
            error_message = coalesce(error_message, $2), updated_at = now()
      where media_asset_id = any($1::uuid[]) and status in ('queued', 'processing')`, [ids, reason.slice(0, 240)],
  );

  const affectedQueues = await client.query<{ id: string; duplicate_asset_ids: unknown; dedup_summary: unknown }>(
    `select id, duplicate_asset_ids, dedup_summary
       from public.review_queue q
      where q.status = 'pending'
        and q.duplicate_asset_ids ?| $1::text[]
      for update`, [ids],
  );
  const removedSet = new Set(ids);
  for (const queue of affectedQueues.rows) {
    const duplicateIds = jsonArray(queue.duplicate_asset_ids)
      .filter((value): value is string => typeof value === 'string' && !removedSet.has(value));
    const summary = jsonObject(queue.dedup_summary);
    const nextSummary = { ...summary };
    for (const method of ['phash', 'scene_embedding']) {
      nextSummary[method] = jsonArray(summary[method]).filter((entry) => {
        if (!entry || typeof entry !== 'object') return true;
        const candidateId = (entry as Record<string, unknown>).candidate_media_asset_id;
        return typeof candidateId !== 'string' || !removedSet.has(candidateId);
      });
    }
    const similarities = ['phash', 'scene_embedding'].flatMap((method) => jsonArray(nextSummary[method]))
      .map((entry) => (entry && typeof entry === 'object' ? Number((entry as Record<string, unknown>).similarity) : NaN))
      .filter((value) => Number.isFinite(value));
    await client.query(
      `update public.review_queue
          set duplicate_asset_ids=$2::jsonb, is_duplicate=$3::boolean,
              duplicate_similarity=$4::real, dedup_summary=$5::jsonb
        where id=$1`,
      [queue.id, JSON.stringify(duplicateIds), duplicateIds.length > 0, similarities.length ? Math.max(...similarities) : 0, JSON.stringify(nextSummary)],
    );
  }
  const deletedAtById: Record<string, string | null> = {};
  const deletedByById: Record<string, string | null> = {};
  for (const row of updated.rows) { deletedAtById[row.id] = row.deleted_at; deletedByById[row.id] = row.deleted_by; }
  return {
    deleted: assets.rows.filter((row) => !row.deleted_at).length,
    alreadyDeleted: assets.rows.filter((row) => Boolean(row.deleted_at)).length,
    cancelledJobs: cancelled.rowCount || 0,
    cleanedDuplicateQueues: affectedQueues.rowCount || 0,
    deletedAtById,
    deletedByById,
  };
}

export async function restoreMediaAssets(client: PoolClient, assetIds: string[], _actorId: string) {
  const ids = [...new Set(assetIds)];
  if (!ids.length) return { restored: 0, missing: [] as string[] };
  const result = await client.query<{ id: string }>(
    `update public.media_assets set deleted_at=null, deleted_by=null, updated_at=now()
      where id = any($1::uuid[]) and deleted_at is not null returning id`, [ids],
  );
  const restored = new Set(result.rows.map((row) => row.id));
  return { restored: result.rowCount || 0, missing: ids.filter((id) => !restored.has(id)) };
}
