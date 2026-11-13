import { NextRequest, NextResponse } from 'next/server';

import { retryCreativeGeneration } from '@/lib/server/creative';
import { errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, { params }: Context) {
  try {
    const { user } = await requireNativeReviewer();
    const { id } = await params;
    return NextResponse.json({ data: await retryCreativeGeneration(id, user.id) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
