import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';

import { auth } from '@/lib/auth';
import { DISCOVERY_HEADERS, discoveryPreflight } from '@/lib/server/mcp-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 8414 metadata. The issuer is `<base>/api/auth`, so the spec location is
 * /.well-known/oauth-authorization-server/api/auth; the bare path is served too
 * for clients that only try the root.
 */
export const GET = oauthProviderAuthServerMetadata(auth, { headers: DISCOVERY_HEADERS });
export const OPTIONS = discoveryPreflight;
