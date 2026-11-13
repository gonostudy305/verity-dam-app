import { NextRequest, NextResponse } from "next/server";

import { getCreativeRequestDetail } from "@/lib/server/creative";
import { errorResponse } from "@/lib/server/http";
import { requireNativeContributor } from "@/lib/server/native-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    await requireNativeContributor();
    const { id } = await params;
    return NextResponse.json({ data: await getCreativeRequestDetail(id) });
  } catch (error) {
    return errorResponse(error);
  }
}
