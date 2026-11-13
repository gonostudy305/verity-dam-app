import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { listNativePendingReviewItems } from '@/lib/server/native-media';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { decodeReviewQueueCursor } from '@/lib/server/review-queue-cursor';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireNativeReviewer();
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
    const cursorValue = url.searchParams.get('cursor');
    const cursor = cursorValue ? decodeReviewQueueCursor(cursorValue) : null;
    if (cursorValue && !cursor) {
      return NextResponse.json({ error: 'INVALID_CURSOR', message: 'Cursor hàng chờ không hợp lệ.' }, { status: 400 });
    }
    const status = url.searchParams.get('status') === 'skipped' ? 'skipped' : 'pending';
    const page = await listNativePendingReviewItems(limit, cursor, status);
    return NextResponse.json({
      data: page.data,
      total: page.total,
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
