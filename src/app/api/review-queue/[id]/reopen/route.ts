import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeReviewer } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

/** Moves a "để sau" (skipped) review_queue row back to 'pending' so it
 * reappears in the main review queue. Only ever reopens a skipped row --
 * never an already approved/rejected one, which would re-run correction
 * logging against a decision that already happened. */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID hàng chờ không hợp lệ.');
    await requireNativeReviewer();
    const pool = requireNativeDatabase();
    const result = await pool.query<{ id: string; media_asset_id: string }>(
      `update public.review_queue set status = 'pending', reviewed_by = null, reviewed_at = null
       where id = $1 and status = 'skipped'
       returning id, media_asset_id`,
      [id]
    );
    if (!result.rows[0]) {
      throw new ApiError(409, 'REVIEW_NOT_SKIPPED', 'Ảnh này không còn ở trạng thái "để sau".');
    }
    return NextResponse.json({
      data: { review_queue_id: result.rows[0].id, media_asset_id: result.rows[0].media_asset_id, review_status: 'pending' },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
