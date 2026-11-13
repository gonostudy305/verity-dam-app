import { NextRequest, NextResponse } from 'next/server';
import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor, requireNativeMember } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';
export interface MissingShot { id: string; sku: string; brand: string | null; reason: string; query_origin: string | null; status: 'open' | 'assigned' | 'completed'; created_at: string; }

export async function GET(request: NextRequest) {
  try {
    await requireNativeMember();
    const status = request.nextUrl.searchParams.get('status') ?? 'open';
    const values: string[] = []; const where = status === 'all' ? '' : 'where status = $1'; if (status !== 'all') values.push(status);
    const result = await requireNativeDatabase().query<MissingShot>(`select id, sku, brand, reason, query_origin, status, created_at from public.missing_shots ${where} order by created_at desc limit 100`, values);
    return NextResponse.json({ data: result.rows, total: result.rows.length });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    await requireNativeContributor();
    const body = await request.json();
    const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const queryOrigin = typeof body.query_origin === 'string' ? body.query_origin.trim() || null : null;
    const brand = typeof body.brand === 'string' ? body.brand.trim() || null : null;
    if (!sku || !reason) return NextResponse.json({ error: 'sku and reason are required' }, { status: 400 });
    const result = await requireNativeDatabase().query<{ id: string }>(`insert into public.missing_shots(sku, brand, reason, query_origin, status) values ($1,$2,$3,$4,'open') returning id`, [sku, brand, reason, queryOrigin]);
    return NextResponse.json({ success: true, id: result.rows[0]?.id }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
