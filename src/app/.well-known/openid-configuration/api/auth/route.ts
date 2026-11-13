import { oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider';

import { auth } from '@/lib/auth';
import { DISCOVERY_HEADERS, discoveryPreflight } from '@/lib/server/mcp-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = oauthProviderOpenIdConfigMetadata(auth, { headers: DISCOVERY_HEADERS });
export const OPTIONS = discoveryPreflight;
