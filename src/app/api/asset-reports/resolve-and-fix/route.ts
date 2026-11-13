import { NextRequest, NextResponse } from 'next/server';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { isUuid } from '@/lib/media-api';
import { resolveAndFixAssetReport } from '@/lib/server/asset-reports';
import { getNativeMediaAsset } from '@/lib/server/native-media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeReviewer();
    const body = await request.json().catch(() => {
      throw new ApiError(400, 'INVALID_BODY', 'Nội dung yêu cầu phải là JSON hợp lệ.');
    });

    const mediaAssetId = typeof body?.media_asset_id === 'string' ? body.media_asset_id.trim() : '';
    if (!isUuid(mediaAssetId)) {
      throw new ApiError(400, 'INVALID_MEDIA_ID', 'ID ảnh không hợp lệ.');
    }

    const action = body?.action === 'dismiss' ? 'dismiss' : 'resolve';
    const reportIds: string[] = Array.isArray(body?.report_ids) ? body.report_ids : [];
    const resolutionNote = typeof body?.resolution_note === 'string' ? body.resolution_note.trim() : undefined;
    const mediaUpdates = body?.media_updates && typeof body.media_updates === 'object' ? body.media_updates : undefined;

    const pool = requireNativeDatabase();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await resolveAndFixAssetReport(client, {
        mediaAssetId,
        reportIds,
        action,
        actorId: user.id,
        resolutionNote,
        mediaUpdates,
      });
      await client.query('commit');

      const updatedAsset = await getNativeMediaAsset(mediaAssetId, true, false, true);

      return NextResponse.json({
        success: true,
        data: {
          asset: updatedAsset,
          resolved_count: result.updatedReportCount,
        },
      });
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
