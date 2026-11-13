import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { getTaxonomyConfig, saveTaxonomyConfig } from '@/lib/server/taxonomy';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { DEFAULT_TAXONOMY } from '@/config/taxonomy';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireNativeAdmin();
    return NextResponse.json({ data: await getTaxonomyConfig(true) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireNativeAdmin();
    const body = await request.json().catch(() => null);
    return NextResponse.json({ data: await saveTaxonomyConfig(body, user.id) });
  } catch (error) {
    return errorResponse(error);
  }
}
