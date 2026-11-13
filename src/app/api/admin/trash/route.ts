import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { resolveMediaUrls } from '@/lib/server/native-media';

export const dynamic = 'force-dynamic';

/** Admin-only listing of soft-deleted media_assets rows (Trash). Resolves
 * deleted_by -> deleted_by_email by joining better-auth's "user" table
 * directly (same table public.health/route.ts confirms via
 * to_regclass('public."user"')) rather than adding a new column/migration
 * for a purely-display field. */
export async function GET(request: NextRequest) {
  try {
    await requireNativeAdmin();
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') || 60);
    const rawOffset = Number(url.searchParams.get('offset') || 0);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 60;
    const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(Math.trunc(rawOffset), 0), 10_000) : 0;

    const pool = requireNativeDatabase();
    const [rows, count] = await Promise.all([
      pool.query<{
        id: string; title: string; sku: string; brand: string; category: string;
        storage_path: string | null; thumbnail_path: string | null;
        deleted_at: string; deleted_by: string | null; deleted_by_email: string | null;
      }>(
        `select a.id, a.title, a.sku, a.brand, a.category, a.storage_path, a.thumbnail_path,
                a.deleted_at, a.deleted_by, u.email as deleted_by_email
           from public.media_assets a
           left join public."user" u on u.id = a.deleted_by
          where a.deleted_at is not null
          order by a.deleted_at desc
          limit $1 offset $2`,
        [limit, offset]
      ),
      pool.query<{ count: number }>(`select count(*)::int as count from public.media_assets where deleted_at is not null`),
    ]);

    const urls = resolveMediaUrls(rows.rows);
    const data = rows.rows.map((row) => ({
      id: row.id,
      title: row.title,
      sku: row.sku,
      brand: row.brand,
      category: row.category,
      thumbnail_url: row.thumbnail_path
        ? urls.get(row.thumbnail_path) || urls.get(row.storage_path || '') || ''
        : urls.get(row.storage_path || '') || '',
      deleted_at: row.deleted_at,
      deleted_by_email: row.deleted_by_email,
    }));

    return NextResponse.json({ data, total: count.rows[0]?.count || 0 });
  } catch (error) {
    return errorResponse(error);
  }
}
