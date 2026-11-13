import { NextResponse } from 'next/server';

import { mcpProtectedResourceMetadata } from '@/lib/mcp-oauth';
import { DISCOVERY_HEADERS, discoveryPreflight } from '@/lib/server/mcp-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(mcpProtectedResourceMetadata(), { headers: DISCOVERY_HEADERS });
}
export const OPTIONS = discoveryPreflight;
