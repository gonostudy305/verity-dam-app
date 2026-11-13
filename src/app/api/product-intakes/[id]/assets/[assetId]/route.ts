import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import {
  assertProductIntakesEnabled,
  setProductIntakeAssetMeta,
} from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; assetId: string }> }) {
  try {
    const { id, assetId } = await params;
    assertProductIntakesEnabled();
    const { user, role } = await requireNativeContributor();
    const body = await request.json().catch(() => ({}));
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const data = await setProductIntakeAssetMeta(
      { userId: user.id, canReview: role === 'reviewer' || role === 'admin' },
      id,
      assetId,
      {
        proposedReference: raw.proposed_reference ?? raw.proposedReference,
        proposedRole: raw.proposed_role ?? raw.proposedRole,
        proposedImageCategory: raw.proposed_image_category ?? raw.proposedImageCategory,
        proposedAngle: raw.proposed_angle ?? raw.proposedAngle,
        title: raw.title,
      },
    );
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
