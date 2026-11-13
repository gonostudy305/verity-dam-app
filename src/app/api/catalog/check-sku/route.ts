import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeMember } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    await requireNativeMember();
    const rawSku = request.nextUrl.searchParams.get('sku')?.trim() || '';
    if (!rawSku || rawSku.length < 2) {
      return NextResponse.json({ exists: false, product: null });
    }

    const skuQuery = rawSku.slice(0, 100).toLowerCase();
    const pool = requireNativeDatabase();
    const result = await pool.query<{
      id: string;
      primary_sku: string;
      code: string | null;
      display_name: string;
      brand: string | null;
      model_name: string | null;
      category: string | null;
    }>(
      `select id, primary_sku, code, display_name, brand, model_name, category
         from public.verity_products
        where lifecycle <> 'discontinued'
          and (
            lower(primary_sku) = $1
            or lower(code) = $1
            or exists (select 1 from unnest(aliases) a where lower(a) = $1)
          )
        limit 1`,
      [skuQuery]
    );

    const product = result.rows[0];
    if (!product) {
      return NextResponse.json({ exists: false, product: null });
    }

    return NextResponse.json({
      exists: true,
      product: {
        id: String(product.id),
        primary_sku: product.primary_sku,
        code: product.code,
        display_name: product.display_name,
        brand: product.brand,
        model_name: product.model_name,
        category: product.category,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
