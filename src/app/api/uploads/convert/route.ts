import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  createStorageFileName,
  validateUploadCandidate,
  ValidationError,
} from '@/lib/media-api';
import { errorResponse, ApiError } from '@/lib/server/http';
import { optimizeUploadBuffer } from '@/lib/server/image-convert';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { putR2Object } from '@/lib/server/r2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeContributor();
    const formData = await request.formData().catch(() => {
      throw new ValidationError('Yêu cầu phải là multipart/form-data.');
    });

    const file = formData.get('file');
    if (!file || typeof file !== 'object' || !(file instanceof Blob)) {
      throw new ValidationError('Không tìm thấy tệp trong yêu cầu.');
    }

    const fileName = file.name;
    const candidate = validateUploadCandidate({
      name: fileName,
      size: file.size,
      type: file.type,
    });

    const arrayBuffer = await file.arrayBuffer();
    const inputBuffer = Buffer.from(arrayBuffer);

    // Convert PNG/HEIC/AVIF/GIF -> WebP (quality 82, no resize), JPEG > 10MB -> JPEG (quality 88), etc.
    let optimized;
    try {
      optimized = await optimizeUploadBuffer(inputBuffer, candidate.fileName, candidate.mimeType);
    } catch (err) {
      throw new ApiError(422, 'IMAGE_OPTIMIZATION_FAILED', `Không thể tối ưu ảnh: ${err instanceof Error ? err.message : String(err)}`);
    }

    const now = new Date();
    const folder = `${user.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const storagePath = `${folder}/${crypto.randomUUID()}-${createStorageFileName(optimized.fileName)}`;

    await putR2Object(storagePath, user.id, optimized.buffer, optimized.mimeType);

    return NextResponse.json({
      storagePath,
      fileName: optimized.fileName,
      mimeType: optimized.mimeType,
      sizeBytes: optimized.sizeBytes,
      // Hash of the exact bytes stored on R2 (what the worker later re-hashes), so
      // /api/uploads/complete can detect an identical re-upload immediately.
      sha256: createHash('sha256').update(optimized.buffer).digest('hex'),
      originalFileName: candidate.fileName,
      converted: optimized.converted,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
