/**
 * OAuth 2.1 helpers for the remote MCP server (pure, no server imports).
 *
 * The Next.js app is the authorization server (Better Auth `mcp()` plugin,
 * issuer = BETTER_AUTH_URL + /api/auth). The Python MCP server is the resource
 * server; its URL is the token audience.
 */

type Env = Record<string, string | undefined>;

const AUTH_BASE_PATH = '/api/auth';

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function appBaseUrl(env: Env = process.env): string {
  return trimSlash(env.BETTER_AUTH_URL?.trim() || 'http://localhost:3000');
}

/** Token audience: the public MCP URL (same rule as the settings page). */
export function mcpOAuthResource(env: Env = process.env): string {
  const explicit = env.VERITY_MCP_PUBLIC_URL?.trim();
  return explicit ? trimSlash(explicit) : `${appBaseUrl(env)}/mcp`;
}

/** Issuer Better Auth puts in `iss`: its baseURL including the basePath. */
export function mcpOAuthIssuer(env: Env = process.env): string {
  return `${appBaseUrl(env)}${AUTH_BASE_PATH}`;
}

/** RFC 9728 Protected Resource Metadata for the MCP server. */
export function mcpProtectedResourceMetadata(env: Env = process.env) {
  return {
    resource: mcpOAuthResource(env),
    authorization_servers: [mcpOAuthIssuer(env)],
    bearer_methods_supported: ['header'],
    resource_name: 'VerityDAM MCP',
  };
}

const SIGNED_QUERY_KEYS = new Set(['sig', 'exp']);

/**
 * After the user signs in on /login during an OAuth flow, the authorize
 * request must be replayed with the new session. Better Auth sends the user
 * to the login page with the original authorize params plus a signature
 * (sig, exp, ba_*); this rebuilds the plain authorize URL. Returns null when
 * the login page was not opened by the OAuth provider.
 */
export function oauthAuthorizeResumeUrl(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get('sig') || !params.get('client_id') || !params.get('response_type')) return null;

  const resumed = new URLSearchParams();
  params.forEach((value, key) => {
    if (SIGNED_QUERY_KEYS.has(key) || key.startsWith('ba_')) return;
    if (key === 'prompt') {
      // `login` was satisfied by signing in; replaying it would loop.
      const rest = value.split(' ').filter((item) => item && item !== 'login');
      if (rest.length) resumed.set(key, rest.join(' '));
      return;
    }
    resumed.append(key, value);
  });
  return `${AUTH_BASE_PATH}/oauth2/authorize?${resumed.toString()}`;
}

/**
 * The signed subset of the page query that the consent endpoint verifies
 * (same rule as Better Auth's oauthProviderClient: `sig`, `ba_param` and the
 * parameters `ba_param` lists).
 */
export function signedOAuthQuery(search: string): string | null {
  const params = new URLSearchParams(search);
  const signedNames = new Set(params.getAll('ba_param'));
  if (!params.has('sig') || signedNames.size === 0) return null;
  const signed = new URLSearchParams();
  params.forEach((value, key) => {
    if (key === 'sig' || key === 'ba_param' || signedNames.has(key)) signed.append(key, value);
  });
  return signed.toString();
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Xác nhận danh tính của bạn',
  profile: 'Xem tên hiển thị',
  email: 'Xem địa chỉ email',
  offline_access: 'Duy trì kết nối (làm mới token) khi bạn không trực tuyến',
};

export function describeScopes(scope: string | null | undefined): { scope: string; label: string }[] {
  return (scope || '')
    .split(' ')
    .filter(Boolean)
    .map((item) => ({ scope: item, label: SCOPE_LABELS[item] ?? item }));
}

/**
 * Redirect returned by the consent endpoint: http(s) or a native client
 * scheme (vscode://, cursor://); script-capable schemes are refused.
 */
export function safeRedirect(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    // Native/desktop MCP clients use custom schemes (e.g. vscode://, cursor://).
    if (/^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol) && !['javascript:', 'data:', 'vbscript:', 'file:'].includes(parsed.protocol)) {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}
