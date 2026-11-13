import { NextRequest, NextResponse } from "next/server";

import { isUuid } from "@/lib/media-api";
import { ApiError, errorResponse, notFound } from "@/lib/server/http";
import { requireNativeContributor } from "@/lib/server/native-auth";
import { requireNativeDatabase } from "@/lib/server/native-db";
import { getR2ObjectByKey } from "@/lib/server/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

/** Candidate previews are private and served by ID, never by client-supplied R2 key. */
export async function GET(_request: NextRequest, { params }: Context) {
  try {
    await requireNativeContributor();
    const { id } = await params;
    if (!isUuid(id))
      throw new ApiError(400, "INVALID_ID", "Output không hợp lệ.");
    const result = await requireNativeDatabase().query<{
      temp_storage_key: string;
      creative_state: string;
      expires_at: string;
    }>(
      `select temp_storage_key, creative_state, expires_at from public.ai_image_generation_outputs where id = $1`,
      [id],
    );
    const output = result.rows[0];
    if (!output) throw notFound("Không tìm thấy candidate.");
    if (
      output.creative_state !== "candidate" ||
      new Date(output.expires_at).getTime() <= Date.now()
    ) {
      throw new ApiError(
        409,
        "CANDIDATE_PREVIEW_UNAVAILABLE",
        "Candidate không còn khả dụng để preview.",
      );
    }
    const object = await getR2ObjectByKey(output.temp_storage_key);
    return new NextResponse(new Uint8Array(object.body), {
      headers: {
        "Content-Type": object.contentType || "image/webp",
        "Content-Length": String(object.sizeBytes),
        "Cache-Control": "private, no-store",
        "Cross-Origin-Resource-Policy": "same-site",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
