import { NextRequest, NextResponse } from 'next/server';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { resolveNativeMediaAsset } from '@/lib/server/native-media';
import { requireNativeMember, requireNativeAdmin } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const rawTarget = searchParams.get('url') || searchParams.get('path') || searchParams.get('query') || '';
    if (!rawTarget || !rawTarget.trim()) {
      throw new ApiError(400, 'MISSING_PARAM', 'Vui lòng cung cấp tham số url hoặc path để tra cứu.');
    }

    const includeDeleted = ['1', 'true'].includes((searchParams.get('include_deleted') || '').toLowerCase());
    const context = includeDeleted ? await requireNativeAdmin() : await requireNativeMember();

    const asset = await resolveNativeMediaAsset(
      rawTarget,
      context.role === 'reviewer' || context.role === 'admin',
      includeDeleted,
      context.role !== 'viewer'
    );

    if (!asset) {
      throw notFound('Không tìm thấy hình ảnh tương ứng với đường dẫn này.');
    }

    return NextResponse.json({ success: true, data: asset });
  } catch (error) {
    return errorResponse(error);
  }
}
