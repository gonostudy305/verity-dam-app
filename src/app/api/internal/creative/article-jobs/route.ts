import { NextRequest, NextResponse } from 'next/server';

import { createCreativeArticleJob, parseCreativeArticlePayload } from '@/lib/server/creative';
import { errorResponse } from '@/lib/server/http';
import { requireInternalServiceActor } from '@/lib/server/internal-service-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const actor = await requireInternalServiceActor(request);
    const key = request.headers.get('idempotency-key') || '';
    const body = await request.json();
    const result = await createCreativeArticleJob(parseCreativeArticlePayload(body), key, actor.id);
    return NextResponse.json({ data: result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

