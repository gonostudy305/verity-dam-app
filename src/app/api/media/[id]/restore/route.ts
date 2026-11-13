import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeAdmin } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

/** Reverses the soft-delete in DELETE /api/media/[id]/route.ts -- clears
 * deleted_at/deleted_by so the asset becomes visible in the Library and
 * review queue again. Does not resurrect any ingest job that was cancelled
 * at delete time; that is a separate, unrelated concern. */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    await requireNativeAdmin();
    const pool = requireNativeDatabase();
    const result = await pool.query<{ id: string }>(
      `update public.media_assets
          set deleted_at = null, deleted_by = null, updated_at = now()
        where id = $1 and deleted_at is not null
        returning id`,
      [id]
    );
    if (!result.rows[0]) throw notFound();
    return NextResponse.json({ success: true, data: { id: result.rows[0].id } });
  } catch (error) {
    return errorResponse(error);
  }
}
