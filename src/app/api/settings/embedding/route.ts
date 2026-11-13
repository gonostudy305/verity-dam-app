import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { getSharedEmbeddingConfig, saveSharedEmbeddingConfig } from '@/lib/server/embedding-config';
import { requireNativeAdmin } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

async function configurationActor() {
  return requireNativeAdmin();
}

export async function GET() {
  try {
    await configurationActor();
    return NextResponse.json({ data: await getSharedEmbeddingConfig() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const context = await configurationActor();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new ApiError(400, 'INVALID_EMBEDDING_CONFIG', 'Request body is missing or invalid.');
    }
    const data = await saveSharedEmbeddingConfig(body, context.user.id);
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
