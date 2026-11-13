import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { getSharedCreativeConfig, saveSharedCreativeConfig } from '@/lib/server/creative-config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireNativeAdmin();
    return NextResponse.json({ data: await getSharedCreativeConfig() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await requireNativeAdmin();
    const body = await request.json().catch(() => null);
    return NextResponse.json({ data: await saveSharedCreativeConfig(body, context.user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
