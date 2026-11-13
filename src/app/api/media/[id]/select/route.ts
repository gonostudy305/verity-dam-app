import { NextRequest, NextResponse } from 'next/server';

import { isUuid, ValidationError } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeMember } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    }

    const { user } = await requireNativeMember();
    const body = await request.json().catch(() => ({}));

    const channel = typeof body.channel === 'string' && body.channel.trim()
      ? body.channel.trim().slice(0, 100)
      : 'select';
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
    const usedBy = user.email || user.id;

    const pool = requireNativeDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const assetCheck = await client.query<{ id: string }>(
        'SELECT id FROM public.media_assets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [id]
      );
      if (assetCheck.rows.length === 0) {
        throw notFound('Không tìm thấy tệp media.');
      }

      const insertRes = await client.query<{ id: string; used_at: string }>(
        `INSERT INTO public.media_usages (media_asset_id, channel, used_by, note, used_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id, used_at`,
        [id, channel, usedBy, note]
      );

      const updateRes = await client.query<{ usage_count: number }>(
        `UPDATE public.media_assets
         SET usage_count = coalesce(usage_count, 0) + 1,
             updated_at = now()
         WHERE id = $1
         RETURNING usage_count`,
        [id]
      );

      await client.query('COMMIT');

      return NextResponse.json({
        data: {
          usage_id: insertRes.rows[0].id,
          media_asset_id: id,
          channel,
          used_by: usedBy,
          used_at: insertRes.rows[0].used_at,
          usage_count: updateRes.rows[0]?.usage_count ?? 1,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
