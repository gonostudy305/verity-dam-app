import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Batch 4: admin-only manual retry for a stuck ingest job. Only ever
 * touches a row already in 'failed' or 'blocked' -- never an in-flight
 * 'queued'/'processing' row, and never a completed 'succeeded'/'cancelled'
 * one (the where clause below is the only guard needed; there is no
 * separate read-then-write race since it's a single conditional UPDATE).
 *
 * Resets attempts to 0: the worker's claim query (claim_job in
 * backend/app/native_gateway.py) requires attempts < max_attempts, so a job
 * that already exhausted its attempts would sit in 'queued' forever even
 * after this call -- silently doing nothing despite the button claiming to
 * retry it. Resetting attempts is what makes "retry" actually retry. */
export async function POST(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID không hợp lệ.');
    }
    await requireNativeAdmin();

    const pool = requireNativeDatabase();
    const result = await pool.query<{ id: string }>(
      `update public.media_ingest_jobs
          set status = 'queued', attempts = 0, run_after = now(),
              locked_at = null, locked_by = null, error_message = null, updated_at = now()
        where id = $1 and status in ('failed', 'blocked')
        returning id`,
      [id]
    );
    if (!result.rows[0]) throw notFound();

    return NextResponse.json({ success: true, data: { id, status: 'queued' } });
  } catch (error) {
    return errorResponse(error);
  }
}
