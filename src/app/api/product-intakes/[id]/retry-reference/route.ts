import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { assertProductIntakesEnabled, retryProductIntakeReference } from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    assertProductIntakesEnabled();
    const { user } = await requireNativeReviewer();
    const data = await retryProductIntakeReference({ userId: user.id, canReview: true }, id);
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
