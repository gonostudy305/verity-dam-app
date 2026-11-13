import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import {
  assertProductIntakesEnabled,
  createProductIntake,
  listProductIntakes,
  type ProductIntakeDraftInput,
} from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function draftInput(body: Record<string, unknown>): ProductIntakeDraftInput {
  return {
    selectedProductId: null,
    proposedName: (body.proposed_name ?? body.proposedName) as string | undefined,
    proposedBrand: (body.proposed_brand ?? body.proposedBrand) as string | undefined,
    proposedModel: (body.proposed_model ?? body.proposedModel) as string | null | undefined,
    proposedSku: (body.proposed_sku ?? body.proposedSku) as string | null | undefined,
    proposedCategory: (body.proposed_category ?? body.proposedCategory) as string | null | undefined,
    proposedSpace: (body.proposed_space ?? body.proposedSpace) as string | null | undefined,
    sourceUrl: (body.source_url ?? body.sourceUrl) as string | null | undefined,
    notes: body.notes as string | null | undefined,
  };
}

export async function GET(request: NextRequest) {
  try {
    assertProductIntakesEnabled();
    const { user, role } = await requireNativeContributor();
    const data = await listProductIntakes(
      { userId: user.id, canReview: role === 'reviewer' || role === 'admin' },
      request.nextUrl.searchParams.get('status')
    );
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertProductIntakesEnabled();
    const { user, role } = await requireNativeContributor();
    const body = await request.json().catch(() => ({}));
    const data = await createProductIntake(
      { userId: user.id, canReview: role === 'reviewer' || role === 'admin' },
      draftInput(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {})
    );
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
