import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { attachMediaAssetProduct } from '@/lib/server/native-media';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Phase 02: POST /api/media/[id]/products
 * Attaches a non-primary product link to a media asset by SKU.
 * Primary product identity remains exclusively owned by media_assets.sku. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID không hợp lệ.');
    }

    const body = (await request.json().catch(() => ({}))) as { sku?: string; role?: string };
    if (!body.sku || typeof body.sku !== 'string' || !body.sku.trim()) {
      throw new ApiError(400, 'INVALID_SKU', 'SKU không được để trống.');
    }

    const authCtx = await requireNativeReviewer();

    const link = await attachMediaAssetProduct({
      mediaAssetId: id,
      sku: body.sku,
      role: body.role,
      createdBy: authCtx.user?.id ?? null,
    });

    return NextResponse.json({ success: true, data: link });
  } catch (error) {
    return errorResponse(error);
  }
}
