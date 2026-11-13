import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeMember } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await requireNativeMember();
    const searchParams = request.nextUrl.searchParams;
    const rawSku = searchParams.get('sku')?.trim() || '';
    if (!rawSku || rawSku.length < 2) {
      return NextResponse.json({ data: null });
    }

    const skuQuery = rawSku.slice(0, 100);
    const pool = requireNativeDatabase();
    const result = await pool.query<{
      primary_sku: string;
      code: string | null;
      display_name: string;
      brand: string | null;
      model_name: string | null;
      category: string | null;
      catalog_sku_kind: string | null;
    }>(
      `select primary_sku, code, display_name, brand, model_name, category, catalog_sku_kind
       from public.verity_products
       where lifecycle <> 'discontinued'
         and (
           lower(primary_sku) = lower($1)
           or lower(code) = lower($1)
           or lower(model_name) = lower($1)
           or exists (select 1 from unnest(aliases) a where lower(a) = lower($1))
         )
       order by case
         when source_system != 'auto_sku' then 0
         else 1
       end,
       case
         when lower(primary_sku) = lower($1) then 1
         when lower(code) = lower($1) then 2
         when lower(model_name) = lower($1) then 3
         when exists (select 1 from unnest(aliases) a where lower(a) = lower($1)) then 4
         else 5
       end
       limit 1`,
      [skuQuery]
    );

    const product = result.rows[0];
    if (!product) {
      return NextResponse.json({ data: null });
    }

    return NextResponse.json({
      data: {
        primary_sku: product.primary_sku,
        code: product.code,
        display_name: product.display_name,
        brand: product.brand,
        model_name: product.model_name,
        category: product.category,
        catalog_sku_kind: product.catalog_sku_kind,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
