import { NextResponse } from 'next/server';
import { isProductIntakesEnabled } from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/features
 *
 * Lightweight feature flags check that always returns HTTP 200.
 */
export async function GET() {
  return NextResponse.json({
    product_intakes: isProductIntakesEnabled(),
    sso_login: false,
  });
}
