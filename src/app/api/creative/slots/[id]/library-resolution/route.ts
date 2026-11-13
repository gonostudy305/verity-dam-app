import { NextRequest, NextResponse } from 'next/server';

import { activateLibraryResolution } from '@/lib/server/creative';
import { errorResponse, ApiError } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { user } = await requireNativeReviewer();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    if (typeof body.media_asset_id !== 'string') throw new ApiError(400, 'INVALID_MEDIA_ASSET_ID', 'media_asset_id là bắt buộc.');
    const result = await activateLibraryResolution(id, body.media_asset_id, user.id);
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

