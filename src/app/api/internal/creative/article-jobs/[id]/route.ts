import { NextRequest, NextResponse } from 'next/server';

import { getCreativePlacementManifest } from '@/lib/server/creative';
import { errorResponse, ApiError } from '@/lib/server/http';
import { requireInternalServiceActor } from '@/lib/server/internal-service-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Context) {
  try {
    await requireInternalServiceActor(request);
    const { id } = await params;
    const result = await requireNativeDatabase().query<{ id: string; status: string; external_article_id: string | null; external_revision: string | null }>(
      `select id, status, external_article_id, external_revision from public.creative_requests where id = $1 limit 1`, [id]
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Creative request không tồn tại.');
    const manifest = await getCreativePlacementManifest(id);
    return NextResponse.json({ data: { ...row, manifest } });
  } catch (error) {
    return errorResponse(error);
  }
}

