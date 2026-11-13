import { NextRequest, NextResponse } from "next/server";
import { getR2ObjectByKey, isValidStorageKey } from "@/lib/server/r2";
import { requireNativeMember } from "@/lib/server/native-auth";
import { nativeQuery } from "@/lib/server/native-db";

/** Maximum cache age for R2 proxied images (1 week). */
const CACHE_MAX_AGE = 60 * 60 * 24 * 7;

/**
 * GET /api/r2-proxy?key=<storage_key>
 *
 * Proxies a private R2 object through the Next.js server so the browser
 * fetches from the same origin (dam.verity.internal) instead of directly from
 * the R2 public URL — which is either private (403) or lacks CORS headers
 * needed by canvas-based image exports.
 *
 * Auth: only objects represented by a non-deleted DAM asset may be proxied.
 * Public, approved assets are available anonymously; all other known assets
 * require a member session. This intentionally prevents an authenticated
 * member from using this endpoint as a generic R2-key reader.
 *
 * Cache: 7-day CDN cache via s-maxage + immutable. The key encodes a
 * UUID so each upload generates a unique URL; cache-busting is not needed.
 */
export async function GET(request: NextRequest) {
  // 1. Validate key param
  const key = request.nextUrl.searchParams.get("key");
  if (!key || typeof key !== "string" || key.trim().length === 0) {
    return NextResponse.json({ error: "Missing key" }, { status: 400 });
  }

  // 2. Basic key sanity: no path traversal, no absolute paths
  const cleanKey = key.trim();
  if (!isValidStorageKey(cleanKey)) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 });
  }

  // 3. Check authorization & asset sensitivity:
  let isPublicApproved = false;
  let assetExists = false;
  try {
    const assetCheck = await nativeQuery<{
      permission: string;
      review_state: string;
      deleted_at: Date | null;
    }>(
      `SELECT a.permission, a.review_state, a.deleted_at
       FROM public.media_assets a
       WHERE (
           a.storage_path = $1
           OR a.thumbnail_path = $1
           OR EXISTS (
             SELECT 1 FROM public.media_renditions r
             WHERE r.media_asset_id = a.id AND r.cdn_key = $1
           )
         )
       LIMIT 1`,
      [cleanKey],
    );
    if (assetCheck.rows.length > 0) {
      assetExists = true;
      const row = assetCheck.rows[0];
      // Public anonymous access only for active (non-deleted) approved public assets.
      // Soft-deleted assets (in Trash) require an authenticated member session below.
      if (row.permission === "public" && row.review_state === "approved" && !row.deleted_at) {
        isPublicApproved = true;
      }
    }
  } catch (err) {
    console.error("[r2-proxy] Error checking asset authorization:", err);
    return NextResponse.json(
      { error: "Asset authorization unavailable" },
      { status: 503 },
    );
  }

  if (!assetExists) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // If not explicitly public and approved, require native member authentication.
  if (!isPublicApproved) {
    try {
      await requireNativeMember();
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // 4. Fetch from R2 server-side
  try {
    const { body, contentType, sizeBytes } = await getR2ObjectByKey(cleanKey);

    const cacheHeader = isPublicApproved
      ? `public, max-age=${CACHE_MAX_AGE}, s-maxage=${CACHE_MAX_AGE}, immutable`
      : "private, no-cache, no-store, must-revalidate";

    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType || "application/octet-stream",
        "Content-Length": String(sizeBytes),
        "Cache-Control": cacheHeader,
        // Allow canvas/fetch access from the same origin (no CORS issue since same-origin)
        "Access-Control-Allow-Origin": request.headers.get("origin") || "*",
        "Cross-Origin-Resource-Policy": "same-site",
      },
    });
  } catch (error: unknown) {
    const status =
      error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode: number }).statusCode)
        : 500;
    if (status === 404) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("[r2-proxy] Error fetching R2 object:", error);
    return NextResponse.json({ error: "Storage error" }, { status: 500 });
  }
}
