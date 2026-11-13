/** Public OAuth discovery documents: cacheable and readable cross-origin. */
export const DISCOVERY_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-protocol-version',
  'Cache-Control': 'public, max-age=300',
};

export function discoveryPreflight(): Response {
  return new Response(null, { status: 204, headers: DISCOVERY_HEADERS });
}
