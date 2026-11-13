import { NextRequest, NextResponse } from 'next/server';

import { ValidationError } from '@/lib/media-api';
import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { assertProductIntakesEnabled } from '@/lib/server/product-intakes';
import { extractImageCandidates, MAX_IMAGE_CANDIDATES } from '@/lib/server/product-image-extract';
import { parsePublicHttpUrl, safeFetch } from '@/lib/server/url-fetch-guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** HTML thôi thì 2 MB đã quá dư; trang nào nặng hơn là trang không đáng parse. */
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * POST /api/uploads/from-url/extract
 * Body: { page_url: string }
 *
 * Đọc HTML của một trang sản phẩm và trả về danh sách URL ảnh ứng viên để
 * người khai tick chọn. Chỉ đọc, không tải ảnh và không ghi gì — phần tốn băng
 * thông nằm ở /api/uploads/from-url/fetch, chạy sau khi đã chọn.
 */
export async function POST(request: NextRequest) {
  try {
    assertProductIntakesEnabled();
    await requireNativeContributor();

    const body = await request.json().catch(() => {
      throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.');
    });
    const rawUrl = body && typeof body === 'object' ? (body as Record<string, unknown>).page_url : null;
    const pageUrl = parsePublicHttpUrl(rawUrl, 'INVALID_SOURCE_URL');

    const response = await safeFetch(pageUrl.toString(), {
      maxBytes: MAX_HTML_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      accept: 'text/html,application/xhtml+xml',
      code: 'SOURCE_PAGE_FETCH_FAILED',
    });

    // Dán thẳng link ảnh cũng chạy: coi chính nó là ứng viên duy nhất.
    if (response.contentType.startsWith('image/')) {
      return NextResponse.json({
        data: { page_url: response.finalUrl, candidates: [{ url: response.finalUrl, source: 'direct' }] },
      });
    }

    const candidates = extractImageCandidates(
      response.buffer.toString('utf8'),
      response.finalUrl,
      MAX_IMAGE_CANDIDATES
    );

    return NextResponse.json({ data: { page_url: response.finalUrl, candidates } });
  } catch (error) {
    return errorResponse(error);
  }
}
