import { NextRequest, NextResponse } from 'next/server';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin, requireNativeMember } from '@/lib/server/native-auth';
import type { SynonymItem } from '@/lib/server/synonym-types';
import { getNativeSynonymsConfig, saveNativeSynonymsConfig, bustNativeSynonymsCache } from '@/lib/server/native-synonyms';

export const dynamic = 'force-dynamic';

// ── GET /api/settings/synonyms ────────────────────────────────────────────────
// Any authenticated member can read the shared synonym dictionary.
export async function GET() {
  try {
    await requireNativeMember();
    const items = await getNativeSynonymsConfig();
    return NextResponse.json({ items });
  } catch (error) {
    return errorResponse(error);
  }
}

// ── PUT /api/settings/synonyms ────────────────────────────────────────────────
// Only admins may update the shared synonym dictionary.
export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireNativeAdmin();

    const body = await request.json().catch(() => {
      throw new Error('Request body must be valid JSON.');
    });

    if (!Array.isArray(body?.items)) {
      return NextResponse.json(
        { error: 'INVALID_INPUT', message: 'Body must have an "items" array.' },
        { status: 400 },
      );
    }

    if (body.items.length > 500) {
      throw new ApiError(400, 'INVALID_INPUT', 'The synonym dictionary may contain at most 500 items.');
    }

    // Validate and normalize each item before writing JSONB. This keeps bad
    // values from becoming an unbounded query-expansion payload.
    const items = body.items as unknown[];
    const validated: SynonymItem[] = items.map((item, i) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof (item as Record<string, unknown>).id !== 'string' ||
        typeof (item as Record<string, unknown>).from !== 'string' ||
        typeof (item as Record<string, unknown>).to !== 'string'
      ) {
        throw new ApiError(400, 'INVALID_INPUT', `Item at index ${i} must have string fields: id, from, to.`);
      }

      const value = item as Record<string, string>;
      const id = value.id.trim();
      const from = value.from.trim();
      const to = value.to.trim();
      if (!id || !from || !to || id.length > 128 || from.length > 256 || to.length > 2000) {
        throw new ApiError(400, 'INVALID_INPUT', `Item at index ${i} contains an empty or oversized value.`);
      }
      return { id, from, to };
    });

    const saved = await saveNativeSynonymsConfig(validated, user.email ?? user.id);

    // Bust cache so the next search request picks up new data immediately
    bustNativeSynonymsCache();

    return NextResponse.json({ items: saved });
  } catch (error) {
    return errorResponse(error);
  }
}
