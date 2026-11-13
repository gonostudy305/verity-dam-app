import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import {
  assertProductIntakesEnabled,
  decideProductIntake,
  type ProductIntakeAssetDecisionInput,
} from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function assetDecisions(value: unknown): ProductIntakeAssetDecisionInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const raw = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    return {
      mediaAssetId: String(raw.media_asset_id ?? raw.mediaAssetId ?? ''),
      decision: raw.decision as ProductIntakeAssetDecisionInput['decision'],
      isReference: raw.is_reference === true || raw.isReference === true,
      role: (raw.role ?? raw.reference_role) as ProductIntakeAssetDecisionInput['role'],
      imageCategory: (raw.image_category ?? raw.imageCategory) as ProductIntakeAssetDecisionInput['imageCategory'],
    };
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    assertProductIntakesEnabled();
    const { user } = await requireNativeReviewer();
    const body = await request.json().catch(() => ({}));
    const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const data = await decideProductIntake(
      { userId: user.id, canReview: true },
      id,
      {
        decision: raw.decision as 'approved' | 'needs_changes' | 'rejected',
        expectedRevision: raw.expected_revision ?? raw.expectedRevision,
        finalSku: (raw.final_sku ?? raw.finalSku) as string | null | undefined,
        reviewerNote: (raw.reviewer_note ?? raw.reviewerNote) as string | null | undefined,
        assetDecisions: assetDecisions(raw.asset_decisions ?? raw.assetDecisions),
      }
    );
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
