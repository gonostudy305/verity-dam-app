import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

const MAX_IDS = 100;
const MAX_KEYWORD_LENGTH = 100;

function sanitizeKeywordList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_KEYWORD_LENGTH);
}

/** Batch 7: the Library's BatchBar "Sửa tag" action was previously a
 * showToast(...) no-op claiming a bulk edit had happened. This is the first
 * real batch-metadata-edit surface -- scoped to keywords (tags) only, since
 * that's what the existing button already promised. Applies remove first,
 * then add, per selected asset -- each asset's own existing keywords are
 * preserved (this is a merge, not a replace). */
export async function PATCH(request: NextRequest) {
  try {
    const { user } = await requireNativeContributor();
    const body = await request.json().catch(() => { throw new ApiError(400, 'INVALID_BODY', 'Nội dung yêu cầu phải là JSON hợp lệ.'); });

    const ids = Array.isArray(body?.ids)
      ? (body.ids as unknown[]).filter((item): item is string => typeof item === 'string' && isUuid(item)).slice(0, MAX_IDS)
      : [];
    const add = sanitizeKeywordList(body?.add);
    const remove = sanitizeKeywordList(body?.remove);

    if (ids.length === 0) throw new ApiError(400, 'NO_IDS', 'Cần chọn ít nhất một ảnh.');
    if (add.length === 0 && remove.length === 0) throw new ApiError(400, 'NO_CHANGES', 'Cần thêm hoặc bỏ ít nhất một tag.');

    const removeSet = new Set(remove);
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      const rows = await client.query<{ id: string; keywords: string[] }>(
        `select id, keywords from public.media_assets where id = any($1::uuid[]) and deleted_at is null for update`,
        [ids]
      );

      const keywordsById: Record<string, string[]> = {};
      for (const row of rows.rows) {
        const current = Array.isArray(row.keywords) ? row.keywords : [];
        const kept = current.filter((keyword) => !removeSet.has(keyword));
        const next = [...new Set([...kept, ...add])];
        keywordsById[row.id] = next;
        await client.query(
          `update public.media_assets set keywords = $2, updated_at = now() where id = $1`,
          [row.id, next]
        );
      }
      await client.query('commit');

      return NextResponse.json({
        success: true,
        data: { updated: rows.rows.length, keywords_by_id: keywordsById, actor: user.id },
      });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
