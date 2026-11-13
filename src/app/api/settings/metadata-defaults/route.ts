import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { getSharedMetadataDefaults, saveSharedMetadataDefaults } from '@/lib/server/metadata-defaults';
import { requireNativeAdmin, requireNativeMember } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireNativeMember();
    return NextResponse.json({ data: await getSharedMetadataDefaults() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await requireNativeAdmin();
    const body = await request.json().catch(() => null);
    const data = await saveSharedMetadataDefaults(body, context.user.id);
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
