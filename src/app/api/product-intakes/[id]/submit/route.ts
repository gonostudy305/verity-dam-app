import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { assertProductIntakesEnabled, submitProductIntake } from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    assertProductIntakesEnabled();
    const { user, role } = await requireNativeContributor();
    const body = await request.json().catch(() => ({}));
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const data = await submitProductIntake(
      { userId: user.id, canReview: role === 'reviewer' || role === 'admin' },
      id,
      raw.expected_revision ?? raw.expectedRevision
    );
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
