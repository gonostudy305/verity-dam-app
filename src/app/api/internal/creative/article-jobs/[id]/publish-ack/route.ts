import { NextRequest, NextResponse } from 'next/server';

import { acknowledgeCreativePlacement } from '@/lib/server/creative';
import { errorResponse } from '@/lib/server/http';
import { requireInternalServiceActor } from '@/lib/server/internal-service-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireInternalServiceActor(request);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    await acknowledgeCreativePlacement(id, actor.id, typeof body.published_at === 'string' ? body.published_at : undefined);
    return NextResponse.json({ data: { request_id: id, acknowledged: true } });
  } catch (error) {
    return errorResponse(error);
  }
}

