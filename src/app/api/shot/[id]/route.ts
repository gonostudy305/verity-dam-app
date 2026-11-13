import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import type { MissingShot } from '../route';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

const TRANSITIONS: Record<string, { from: MissingShot['status'][]; to: MissingShot['status'] }> = {
  assign: { from: ['open'], to: 'assigned' },
  complete: { from: ['open', 'assigned'], to: 'completed' },
  reopen: { from: ['assigned', 'completed'], to: 'open' },
};

/** Batch 7: missing_shots.status could only ever be set to 'open' (on
 * creation, /api/shot POST) before this route -- the Shot List page
 * rendered 'assigned'/'completed' badges and an "all" filter, but nothing
 * in the app could ever produce those states. There is no assignee column
 * on missing_shots (schema only tracks status), so "assign" records intent
 * to work on it, not who -- consistent with what's actually there. */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID không hợp lệ.');
    await requireNativeContributor();
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action : '';
    const transition = TRANSITIONS[action];
    if (!transition) throw new ApiError(400, 'INVALID_ACTION', 'Hành động không hợp lệ (assign, complete, reopen).');

    const pool = requireNativeDatabase();
    const result = await pool.query<MissingShot>(
      `update public.missing_shots
          set status = $2
        where id = $1 and status = any($3::text[])
        returning id, sku, brand, reason, query_origin, status, created_at`,
      [id, transition.to, transition.from]
    );
    if (!result.rows[0]) {
      const exists = await pool.query<{ status: string }>(`select status from public.missing_shots where id = $1`, [id]);
      if (!exists.rows[0]) throw notFound();
      throw new ApiError(409, 'INVALID_TRANSITION', `Không thể chuyển từ trạng thái "${exists.rows[0].status}" bằng hành động này.`);
    }
    return NextResponse.json({ data: result.rows[0] });
  } catch (error) {
    return errorResponse(error);
  }
}
