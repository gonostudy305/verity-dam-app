import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { probeMcpHealth, probePublicRoute, publicMcpUrl } from '@/lib/server/mcp-admin';
import { requireNativeAdmin } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/settings/mcp-status
 * Live status for the settings page: MCP container health (internal) and
 * whether the public URL is actually routed to the MCP server.
 */
export async function GET() {
  try {
    await requireNativeAdmin();
    const publicUrl = publicMcpUrl();
    const [health, publicRoute] = await Promise.all([
      probeMcpHealth(process.env.VERITY_MCP_INTERNAL_URL),
      publicUrl ? probePublicRoute(publicUrl) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      data: { publicUrl, health, publicRoute, checkedAt: new Date().toISOString() },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
