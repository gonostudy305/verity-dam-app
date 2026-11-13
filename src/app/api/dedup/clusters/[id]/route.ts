import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { getDedupCluster } from '@/lib/server/dedup-clusters';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireNativeReviewer();
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID cluster không hợp lệ.');
    const cluster = await getDedupCluster(requireNativeDatabase(), id);
    if (!cluster) throw notFound();
    return NextResponse.json({ success: true, data: cluster });
  } catch (error) {
    return errorResponse(error);
  }
}
