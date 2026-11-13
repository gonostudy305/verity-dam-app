import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { deleteR2ObjectByKey } from '@/lib/server/r2';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

/** Hard-deletes a media_assets row (and, by FK cascade, every dependent row
 * -- review_queue, media_usages, asset_embeddings, etc; see
 * backend/migrations/0003_native_media_schema.sql) plus its R2 objects.
 * Irreversible. Only ever operates on an asset that is already soft-deleted
 * (Trash) -- this route never purges a live asset directly, so "xóa vĩnh
 * viễn" always requires the two-step Trash flow. */
export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    await requireNativeAdmin();
    const pool = requireNativeDatabase();

    const asset = await pool.query<{ id: string; storage_path: string | null; thumbnail_path: string | null }>(
      `select id, storage_path, thumbnail_path from public.media_assets where id = $1 and deleted_at is not null`,
      [id]
    );
    if (!asset.rows[0]) throw notFound();

    const renditions = await pool.query<{ cdn_key: string | null }>(
      `select cdn_key from public.media_renditions where media_asset_id = $1 and cdn_key is not null`,
      [id]
    );

    const keys = [...new Set([
      asset.rows[0].storage_path,
      asset.rows[0].thumbnail_path,
      ...renditions.rows.map((r) => r.cdn_key),
    ].filter((value): value is string => Boolean(value)))];
    const storageCleanupErrors: string[] = [];
    for (const key of keys) {
      try {
        await deleteR2ObjectByKey(key);
      } catch (error) {
        storageCleanupErrors.push(key);
      }
    }

    await pool.query(`delete from public.media_assets where id = $1`, [id]);

    return NextResponse.json({
      success: true,
      data: { id, storage_cleanup_errors: storageCleanupErrors },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
