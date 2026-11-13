import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { getTaxonomyConfig } from '@/lib/server/taxonomy';
import { requireNativeMember } from '@/lib/server/native-auth';
import { DEFAULT_TAXONOMY } from '@/config/taxonomy';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireNativeMember();
    return NextResponse.json({ data: await getTaxonomyConfig(false) });
  } catch (error) {
    return errorResponse(error);
  }
}
