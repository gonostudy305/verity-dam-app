import { NextRequest, NextResponse } from "next/server";

import {
  getCreativeStudioConfiguration,
  saveCreativeStudioConfiguration,
} from "@/lib/server/creative-studio-config";
import { errorResponse } from "@/lib/server/http";
import {
  requireNativeAdmin,
  requireNativeContributor,
} from "@/lib/server/native-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redacted operational readiness/configuration; provider secrets never leave Settings storage. */
export async function GET() {
  try {
    await requireNativeContributor();
    return NextResponse.json({ data: await getCreativeStudioConfiguration() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Every edit creates an immutable version; existing versions are never mutated. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeAdmin();
    return NextResponse.json(
      {
        data: await saveCreativeStudioConfiguration(
          await request.json(),
          user.id,
        ),
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
