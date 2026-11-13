import { NextResponse } from 'next/server';

import { mcpProtectedResourceMetadata } from '@/lib/mcp-oauth';
import { DISCOVERY_HEADERS, discoveryPreflight } from '@/lib/server/mcp-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 9728 metadata for the MCP server (resource https://<host>/mcp). The MCP
 * server's 401 points here via `WWW-Authenticate: resource_metadata=...`.
 */
export function GET() {
  return NextResponse.json(mcpProtectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}
export const OPTIONS = discoveryPreflight;
