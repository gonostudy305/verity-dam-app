import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { saveNativeMediaCropConfig } from '@/lib/server/native-media';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import type { CropConfig } from '@/types/media';

export const dynamic = 'force-dynamic';

const ALLOWED_PRESETS = new Set(['1:1', '9:16', '16:9', '4:5', 'free']);
const MAX_CROP_COORDINATE = 100_000_000;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as { presetId?: unknown; crop?: unknown } | null;

    const presetId = typeof body?.presetId === 'string' ? body.presetId.trim() : '';
    const crop = body?.crop && typeof body.crop === 'object' && !Array.isArray(body.crop)
      ? (body.crop as Record<string, unknown>)
      : null;
    const x = typeof crop?.x === 'number' ? crop.x : Number.NaN;
    const y = typeof crop?.y === 'number' ? crop.y : Number.NaN;
    const width = typeof crop?.width === 'number' ? crop.width : Number.NaN;
    const height = typeof crop?.height === 'number' ? crop.height : Number.NaN;
    const rotation = crop?.rotation === undefined ? 0 : typeof crop.rotation === 'number' ? crop.rotation : Number.NaN;
    const isRounded = crop?.is_rounded === undefined ? false : crop.is_rounded;
    const borderRadius = crop?.border_radius === undefined
      ? 0
      : typeof crop.border_radius === 'number'
        ? crop.border_radius
        : Number.NaN;

    if (
      !ALLOWED_PRESETS.has(presetId) ||
      !crop ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > MAX_CROP_COORDINATE ||
      y + height > MAX_CROP_COORDINATE ||
      !Number.isFinite(rotation) ||
      rotation < -360 ||
      rotation > 360 ||
      typeof isRounded !== 'boolean' ||
      !Number.isFinite(borderRadius) ||
      borderRadius < 0 ||
      borderRadius > MAX_CROP_COORDINATE
    ) {
      throw new ApiError(400, 'INVALID_CROP_PAYLOAD', 'Dữ liệu cấu hình cắt ảnh không hợp lệ.');
    }

    const normalizedCrop: CropConfig = {
      x,
      y,
      width,
      height,
      rotation,
      is_rounded: isRounded,
      border_radius: borderRadius,
    };

    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    }

    const { user } = await requireNativeReviewer();
    const updatedCropConfigs = await saveNativeMediaCropConfig(id, presetId, normalizedCrop, user.email || user.id);

    return NextResponse.json({
      success: true,
      data: updatedCropConfigs,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
