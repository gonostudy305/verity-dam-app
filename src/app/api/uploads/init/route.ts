import { NextRequest, NextResponse } from 'next/server';

import {
  createStorageFileName,
  MAX_UPLOAD_FILES,
  validateUploadCandidate,
  ValidationError,
} from '@/lib/media-api';
import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { createR2UploadUrl } from '@/lib/server/r2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => {
      throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.');
    });
    if (!Array.isArray(body?.files) || body.files.length === 0 || body.files.length > MAX_UPLOAD_FILES) {
      throw new ValidationError('Mỗi lần chỉ được upload từ 1 đến 100 tệp.');
    }

    const context = typeof body.context === 'string' ? body.context.trim().slice(0, 500) : null;
    const files = (body.files as unknown[]).map((entry) =>
      validateUploadCandidate((entry && typeof entry === 'object' ? entry : {}) as {
        name: unknown;
        size: unknown;
        type: unknown;
      })
    );
    const { user } = await requireNativeContributor();
    const now = new Date();
    const folder = `${user.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    const uploads = await Promise.all(files.map(async (file) => {
      const storagePath = `${folder}/${crypto.randomUUID()}-${createStorageFileName(file.fileName)}`;
      const signed = await createR2UploadUrl(storagePath, user.id, file.mimeType, file.sizeBytes);
      return { ...file, storagePath, signedUrl: signed.url, uploadHeaders: signed.headers };
    }));

    return NextResponse.json({ uploads, context });
  } catch (error) {
    return errorResponse(error);
  }
}
