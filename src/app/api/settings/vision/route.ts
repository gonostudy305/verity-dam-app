import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { getSharedVisionConfig, saveSharedVisionConfig } from '@/lib/server/vision-config';

export const dynamic = 'force-dynamic';

async function configurationActor() {
  return requireNativeAdmin();
}

export async function GET() {
  try {
    await configurationActor();
    return NextResponse.json({ data: await getSharedVisionConfig() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await configurationActor();
    const body = await request.json().catch(() => null);
    // Authenticated admin can update vision configuration parameters while
    // securely preserving the existing encrypted API key in PostgreSQL.
    const data = await saveSharedVisionConfig(body, context.user.id);
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
