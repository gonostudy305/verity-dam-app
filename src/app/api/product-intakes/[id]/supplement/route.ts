import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import {
  assertProductIntakesEnabled,
  createProductIntakeSupplement,
} from '@/lib/server/product-intakes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Creates an editable follow-on dossier for adding photos to a product that
 * was already approved through the product-intake workflow. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    assertProductIntakesEnabled();
    const { user, role } = await requireNativeContributor();
    const data = await createProductIntakeSupplement(
      { userId: user.id, canReview: role === 'reviewer' || role === 'admin' },
      id,
    );
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
