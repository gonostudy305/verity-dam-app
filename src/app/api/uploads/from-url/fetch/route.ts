import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

import { createStorageFileName, ValidationError } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { optimizeUploadBuffer } from '@/lib/server/image-convert';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { assertProductIntakesEnabled } from '@/lib/server/product-intakes';
import { putR2Object } from '@/lib/server/r2';
import { parsePublicHttpUrl, safeFetch } from '@/lib/server/url-fetch-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_URLS_PER_REQUEST = 12;
const FETCH_TIMEOUT_MS = 20_000;
/** Ảnh nhỏ hơn mức này là thumbnail/ảnh social bị crop — vào reference corpus
 * chỉ làm nhiễu embedding. Chặn cứng ở server, client cảnh báo sớm hơn. */
const MIN_IMAGE_DIMENSION = 300;

/** sharp format -> MIME được R2 cho phép. Định dạng ngoài bảng này (svg, tiff,
 * pdf...) bị loại; đây mới là nguồn sự thật, không phải Content-Type của site. */
const FORMAT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  heif: 'image/heic',
};

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

function fileNameFromUrl(url: string, extension: string): string {
  const stem = decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.[a-zA-Z0-9]{1,10}$/, '');
  return createStorageFileName(`${stem || 'web-image'}.${extension}`);
}

/**
 * POST /api/uploads/from-url/fetch
 * Body: { image_urls: string[] }
 *
 * Tải các ảnh người khai đã chọn về R2. Về bản chất đây là
 * /api/uploads/convert với nguồn bytes khác (tải từ URL thay vì multipart), nên
 * dùng lại đúng optimizeUploadBuffer + putR2Object; kết quả đưa thẳng vào
 * /api/uploads/complete như một upload bình thường.
 *
 * Key R2 tất định theo URL nguồn, nên import lại cùng một URL sẽ trùng
 * storage_path và rơi vào nhánh "asset đã tồn tại" có sẵn của /complete thay vì
 * tạo bản sao.
 *
 * Trả về từng phần: một ảnh 403 không làm hỏng cả lượt chọn.
 */
export async function POST(request: NextRequest) {
  try {
    assertProductIntakesEnabled();
    const { user } = await requireNativeContributor();

    const body = await request.json().catch(() => {
      throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.');
    });
    const rawUrls = body && typeof body === 'object' ? (body as Record<string, unknown>).image_urls : null;
    if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
      throw new ValidationError('Danh sách ảnh cần tải không hợp lệ.');
    }
    if (rawUrls.length > MAX_URLS_PER_REQUEST) {
      throw new ValidationError(`Mỗi lượt chỉ tải tối đa ${MAX_URLS_PER_REQUEST} ảnh.`);
    }

    const files: Array<Record<string, unknown>> = [];
    const errors: Array<{ url: string; message: string }> = [];

    for (const rawUrl of rawUrls) {
      const label = typeof rawUrl === 'string' ? rawUrl.slice(0, 500) : String(rawUrl);
      try {
        const sourceUrl = parsePublicHttpUrl(rawUrl, 'INVALID_SOURCE_URL').toString();

        const downloaded = await safeFetch(sourceUrl, {
          maxBytes: MAX_IMAGE_BYTES,
          timeoutMs: FETCH_TIMEOUT_MS,
          accept: 'image/*',
          code: 'SOURCE_IMAGE_FETCH_FAILED',
        });

        const metadata = await sharp(downloaded.buffer).metadata().catch(() => null);
        const mimeType = metadata?.format ? FORMAT_TO_MIME[metadata.format] : undefined;
        if (!metadata || !mimeType) {
          throw new ApiError(422, 'SOURCE_NOT_AN_IMAGE', 'Nội dung tại URL không phải ảnh được hỗ trợ.');
        }
        const width = metadata.width || 0;
        const height = metadata.height || 0;
        if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
          throw new ApiError(
            422,
            'SOURCE_IMAGE_TOO_SMALL',
            `Ảnh ${width}×${height} quá nhỏ (tối thiểu ${MIN_IMAGE_DIMENSION}px mỗi chiều).`
          );
        }

        const fileName = fileNameFromUrl(sourceUrl, MIME_TO_EXTENSION[mimeType]);
        const optimized = await optimizeUploadBuffer(downloaded.buffer, fileName, mimeType).catch((err) => {
          throw new ApiError(
            422,
            'IMAGE_OPTIMIZATION_FAILED',
            `Không thể tối ưu ảnh: ${err instanceof Error ? err.message : String(err)}`
          );
        });

        const extension = MIME_TO_EXTENSION[optimized.mimeType] || 'webp';
        const storagePath = `${user.id}/web/${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32)}.${extension}`;
        await putR2Object(storagePath, user.id, optimized.buffer, optimized.mimeType);

        files.push({
          storagePath,
          fileName: optimized.fileName,
          mimeType: optimized.mimeType,
          sizeBytes: optimized.sizeBytes,
          width,
          height,
          // Hash của đúng bytes đã ghi lên R2, để khớp với provenance mà worker
          // tính lại khi promote reference.
          sha256: createHash('sha256').update(optimized.buffer).digest('hex'),
          source_url: sourceUrl,
        });
      } catch (error) {
        errors.push({
          url: label,
          message: error instanceof Error ? error.message : 'Không tải được ảnh từ URL này.',
        });
      }
    }

    if (!files.length) {
      throw new ApiError(
        422,
        'SOURCE_IMAGES_UNAVAILABLE',
        errors[0]?.message || 'Không tải được ảnh nào từ các URL đã chọn.',
        { errors }
      );
    }

    return NextResponse.json({ data: { files, errors } });
  } catch (error) {
    return errorResponse(error);
  }
}
