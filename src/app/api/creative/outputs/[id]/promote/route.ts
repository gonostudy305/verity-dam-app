import { NextRequest, NextResponse } from 'next/server';

import { promoteCreativeOutput } from '@/lib/server/creative';
import { errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, { params }: Context) {
  try {
    const { user } = await requireNativeReviewer();
    const { id } = await params;
    const result = await promoteCreativeOutput(id, user.id);
    return NextResponse.json({ data: result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
