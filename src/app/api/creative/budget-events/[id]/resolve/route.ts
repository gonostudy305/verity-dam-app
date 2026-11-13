import { NextRequest, NextResponse } from 'next/server';

import { resolveCreativeBudgetEvent } from '@/lib/server/creative';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { user } = await requireNativeAdmin();
    const { id } = await params;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || (body.resolution !== 'spent' && body.resolution !== 'not_spent') || typeof body.reason !== 'string') {
      throw new ApiError(400, 'INVALID_BUDGET_RESOLUTION', 'resolution (spent|not_spent) và reason là bắt buộc.');
    }
    const actualMinor = body.actual_minor == null ? undefined : Number(body.actual_minor);
    return NextResponse.json({ data: await resolveCreativeBudgetEvent(id, body.resolution, user.id, body.reason, actualMinor) });
  } catch (error) {
    return errorResponse(error);
  }
}
