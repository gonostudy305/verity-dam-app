import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeMember, requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import {
  createAssetReports,
  listAssetReportsGrouped,
  transitionAssetReports,
  VALID_REPORT_REASONS,
  VALID_REPORT_STATUSES,
  type AssetReportReason,
  type AssetReportStatus,
} from '@/lib/server/asset-reports';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IDS = 100;

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeMember();
    const body = await request.json().catch(() => {
      throw new ApiError(400, 'INVALID_BODY', 'Nội dung yêu cầu phải là JSON hợp lệ.');
    });

    const rawIds: unknown[] = Array.isArray(body?.media_asset_ids) ? body.media_asset_ids : [];
    const mediaAssetIds = rawIds
      .filter((item: unknown): item is string => typeof item === 'string' && isUuid(item))
      .slice(0, MAX_IDS);

    if (mediaAssetIds.length === 0) {
      throw new ApiError(400, 'NO_VALID_ASSET_IDS', 'Không có ID media hợp lệ để báo lỗi.');
    }

    const reportReason = typeof body?.report_reason === 'string' ? body.report_reason.trim() : '';
    if (!VALID_REPORT_REASONS.includes(reportReason as AssetReportReason)) {
      throw new ApiError(400, 'INVALID_REPORT_REASON', 'Lý do báo lỗi không hợp lệ.');
    }

    const rawNote = typeof body?.report_note === 'string' ? body.report_note.trim() : '';
    const reportNote = rawNote.length > 0 ? rawNote.slice(0, 1000) : null;

    if (reportReason === 'other' && (!reportNote || reportNote.length === 0)) {
      throw new ApiError(400, 'NOTE_REQUIRED_FOR_OTHER', 'Vui lòng nhập ghi chú chi tiết khi chọn lý do Khác.');
    }

    const pool = requireNativeDatabase();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { count, reportIds } = await createAssetReports(client, {
        mediaAssetIds,
        reportedBy: user.id,
        reportReason,
        reportNote,
      });
      await client.query('commit');

      return NextResponse.json(
        {
          success: true,
          data: { created: count, report_ids: reportIds },
        },
        { status: 201 }
      );
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    await requireNativeReviewer();
    const { searchParams } = request.nextUrl;

    const assetId = searchParams.get('asset_id') || searchParams.get('media_asset_id');
    if (assetId) {
      if (!isUuid(assetId)) {
        throw new ApiError(400, 'INVALID_ASSET_ID', 'ID ảnh không hợp lệ.');
      }
      const pool = requireNativeDatabase();
      const reportsRes = await pool.query(
        `SELECT r.id, r.media_asset_id, r.reported_by, r.report_reason, r.report_note,
                r.status, r.resolved_by, r.resolved_at, r.resolution_note,
                r.created_at, r.updated_at,
                u.name AS reported_by_name, u.email AS reported_by_email
         FROM public.asset_reports r
         LEFT JOIN public."user" u ON u.id = r.reported_by
         WHERE r.media_asset_id = $1 AND r.status IN ('open', 'in_review')
         ORDER BY r.created_at DESC`,
        [assetId]
      );
      return NextResponse.json({
        success: true,
        data: reportsRes.rows,
      });
    }

    const status = searchParams.get('status') || 'open';
    const reason = searchParams.get('reason') || undefined;
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('page_size') || '20', 10);

    const pool = requireNativeDatabase();
    const result = await listAssetReportsGrouped(pool, {
      status,
      reason,
      page: isNaN(page) ? 1 : page,
      pageSize: isNaN(pageSize) ? 20 : pageSize,
    });

    return NextResponse.json({
      success: true,
      data: result.data,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { user } = await requireNativeReviewer();
    const body = await request.json().catch(() => {
      throw new ApiError(400, 'INVALID_BODY', 'Nội dung yêu cầu phải là JSON hợp lệ.');
    });

    const rawIds: unknown[] = Array.isArray(body?.report_ids) ? body.report_ids : [];
    const reportIds = rawIds
      .filter((item: unknown): item is string => typeof item === 'string' && isUuid(item))
      .slice(0, MAX_IDS);

    if (reportIds.length === 0) {
      throw new ApiError(400, 'NO_VALID_REPORT_IDS', 'Cần chọn ít nhất một báo cáo hợp lệ.');
    }

    const nextStatus = typeof body?.status === 'string' ? body.status.trim() : '';
    if (!VALID_REPORT_STATUSES.includes(nextStatus as AssetReportStatus)) {
      throw new ApiError(400, 'INVALID_STATUS', 'Trạng thái chuyển đổi không hợp lệ.');
    }

    const rawResolutionNote = typeof body?.resolution_note === 'string' ? body.resolution_note.trim() : '';
    const resolutionNote = rawResolutionNote.length > 0 ? rawResolutionNote.slice(0, 1000) : null;

    const pool = requireNativeDatabase();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const { updatedCount } = await transitionAssetReports(client, {
        reportIds,
        nextStatus: nextStatus as AssetReportStatus,
        actorId: user.id,
        resolutionNote,
      });
      await client.query('commit');

      return NextResponse.json({
        success: true,
        data: { updated: updatedCount },
      });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
