import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeMember } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

function escapeIlike(str: string): string {
  return str.replace(/([%_\\])/g, '\\$1');
}

/** Phase 02: GET /api/catalog/search?q=
 * Catalog typeahead search endpoint returning up to 10 products.
 * Member-gated, prefix-matched over primary_sku/code/model_name/display_name. */
export async function GET(request: NextRequest) {
  try {
    await requireNativeMember();

    const searchParams = request.nextUrl.searchParams;
    const rawQ = searchParams.get('q')?.trim() || '';
    if (!rawQ || rawQ.length < 2) {
      return NextResponse.json({ data: [] });
    }

    const cleanQ = rawQ.slice(0, 100);
    const escapedQ = escapeIlike(cleanQ);
    const prefixPattern = `${escapedQ}%`;
    const containsPattern = `%${escapedQ}%`;

    const pool = requireNativeDatabase();
    const result = await pool.query<{
      id: string;
      primary_sku: string;
      code: string | null;
      display_name: string;
      brand: string | null;
      model_name: string | null;
      category: string | null;
      catalog_sku_kind: string | null;
    }>(
      `select id, primary_sku, code, display_name, brand, model_name, category, catalog_sku_kind
         from public.verity_products
        where lifecycle <> 'discontinued'
          and (
            primary_sku ilike $1
            or code ilike $1
            or brand ilike $1
            or model_name ilike $1
            or display_name ilike $1
            or exists (select 1 from unnest(aliases) a where a ilike $1)
            or primary_sku ilike $3
            or code ilike $3
            or brand ilike $3
            or model_name ilike $3
            or display_name ilike $3
            or exists (select 1 from unnest(aliases) a where a ilike $3)
          )
        order by case
          when source_system != 'auto_sku' then 0
          else 1
        end,
        case
          when lower(primary_sku) = lower($2) then 1
          when lower(code) = lower($2) then 2
          when lower(model_name) = lower($2) then 3
          when lower(display_name) = lower($2) then 4
          when lower(brand) = lower($2) then 5
          when exists (select 1 from unnest(aliases) a where lower(a) = lower($2)) then 6
          when primary_sku ilike $1 then 7
          when code ilike $1 then 8
          when model_name ilike $1 then 9
          when display_name ilike $1 then 10
          when brand ilike $1 then 11
          when primary_sku ilike $3 then 12
          when code ilike $3 then 13
          when model_name ilike $3 then 14
          when display_name ilike $3 then 15
          else 16
        end,
        (lifecycle = 'active') desc,
        created_at asc
        limit 10`,
      [prefixPattern, cleanQ, containsPattern]
    );

    return NextResponse.json({
      data: result.rows.map((row) => ({
        id: row.id,
        primary_sku: row.primary_sku,
        code: row.code,
        display_name: row.display_name,
        brand: row.brand,
        model_name: row.model_name,
        category: row.category,
        catalog_sku_kind: row.catalog_sku_kind,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
