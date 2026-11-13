import { NextRequest, NextResponse } from "next/server";

import {
  createCreativeArticleJob,
  listCreativeRequests,
  parseCreativeArticlePayload,
} from "@/lib/server/creative";
import { errorResponse } from "@/lib/server/http";
import { requireNativeContributor } from "@/lib/server/native-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireNativeContributor();
    const requested = Number(request.nextUrl.searchParams.get("limit") || 25);
    const data = await listCreativeRequests(requested);
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Browser-facing counterpart of the internal adapter: same canonical orchestration contract. */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeContributor();
    const key = request.headers.get("idempotency-key") || crypto.randomUUID();
    const result = await createCreativeArticleJob(
      parseCreativeArticlePayload(await request.json()),
      key,
      user.id,
    );
    return NextResponse.json(
      { data: result },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
