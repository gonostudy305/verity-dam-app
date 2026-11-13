import crypto from 'crypto';

import { MCP_TOOLS, type McpAgentRole } from '@/lib/mcp-catalog';
import { ApiError } from '@/lib/server/http';

export const MCP_AGENT_ROLES: readonly McpAgentRole[] = ['viewer', 'contributor', 'reviewer'];
export const MCP_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

export interface McpKeyMaterial {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
}

/** Raw token shown once; only its SHA-256 is stored (same as the MCP server lookup). */
export function generateMcpKey(): McpKeyMaterial {
  const rawKey = `verity_mcp_live_${crypto.randomBytes(24).toString('hex')}`;
  return {
    rawKey,
    keyPrefix: `${rawKey.slice(0, 20)}...`,
    keyHash: crypto.createHash('sha256').update(rawKey).digest('hex'),
  };
}

export interface NewKeyInput {
  name: string;
  email: string;
  role: McpAgentRole;
  expiresInDays: number | null;
}

export function parseNewKeyInput(body: unknown): NewKeyInput {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  const role = value.role ?? 'viewer';
  const expires = value.expiresInDays ?? null;

  if (!name || !email) throw new ApiError(400, 'INVALID_INPUT', 'Tên agent và email là bắt buộc.');
  if (name.length > 128) throw new ApiError(400, 'INVALID_INPUT', 'Tên agent tối đa 128 ký tự.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Định dạng email không hợp lệ.');
  if (typeof role !== 'string' || !MCP_AGENT_ROLES.includes(role as McpAgentRole)) {
    throw new ApiError(400, 'INVALID_ROLE', 'Quyền phải là viewer, contributor hoặc reviewer.');
  }
  if (expires !== null && !MCP_KEY_EXPIRY_DAYS.includes(expires as (typeof MCP_KEY_EXPIRY_DAYS)[number])) {
    throw new ApiError(400, 'INVALID_EXPIRY', 'Thời hạn phải là 30, 90, 365 ngày hoặc không giới hạn.');
  }
  return { name, email, role: role as McpAgentRole, expiresInDays: expires as number | null };
}

export type McpKeyStatus = 'active' | 'revoked' | 'expired';

export function keyStatus(revokedAt: string | Date | null, expiresAt: string | Date | null, now = new Date()): McpKeyStatus {
  if (revokedAt) return 'revoked';
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function isKnownTool(name: unknown): name is string {
  return typeof name === 'string' && MCP_TOOLS.some((tool) => tool.name === name);
}

export interface McpHealthResult {
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
  protocolVersion: string | null;
  rateLimitPerMinute: number | null;
  error: string | null;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

/** Server-side probe of the MCP container's unauthenticated /health. */
export async function probeMcpHealth(internalUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<McpHealthResult> {
  const base = internalUrl?.trim().replace(/\/+$/, '');
  if (!base) {
    return { configured: false, reachable: false, latencyMs: null, protocolVersion: null, rateLimitPerMinute: null, error: 'VERITY_MCP_INTERNAL_URL chưa được cấu hình.' };
  }
  try {
    const { value: response, ms } = await timed(() => fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3000), cache: 'no-store' }));
    if (!response.ok) {
      return { configured: true, reachable: false, latencyMs: ms, protocolVersion: null, rateLimitPerMinute: null, error: `HTTP ${response.status}` };
    }
    const body = (await response.json().catch(() => ({}))) as { protocol_version?: unknown; rate_limit_per_minute?: unknown };
    return {
      configured: true,
      reachable: true,
      latencyMs: ms,
      protocolVersion: typeof body.protocol_version === 'string' ? body.protocol_version : null,
      rateLimitPerMinute: typeof body.rate_limit_per_minute === 'number' ? body.rate_limit_per_minute : null,
      error: null,
    };
  } catch (error) {
    return { configured: true, reachable: false, latencyMs: null, protocolVersion: null, rateLimitPerMinute: null, error: error instanceof Error ? error.message : 'Không kết nối được.' };
  }
}

export type PublicRouteState = 'routed' | 'not_routed' | 'unreachable';

/**
 * Checks the public URL reaches the MCP server (not the web app): an
 * unauthenticated POST must come back 401 with the MCP `WWW-Authenticate`
 * realm. The Next.js app answers 404 for /mcp, which means the tunnel rule is
 * missing.
 */
export async function probePublicRoute(publicUrl: string, fetchImpl: typeof fetch = fetch): Promise<{ state: PublicRouteState; status: number | null; latencyMs: number | null }> {
  try {
    const { value: response, ms } = await timed(() =>
      fetchImpl(publicUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
        redirect: 'manual',
      })
    );
    const realm = response.headers.get('www-authenticate') || '';
    const routed = response.status === 401 && realm.includes('VerityDAM MCP');
    return { state: routed ? 'routed' : 'not_routed', status: response.status, latencyMs: ms };
  } catch {
    return { state: 'unreachable', status: null, latencyMs: null };
  }
}

/** Public MCP URL: explicit override, else the auth base URL + /mcp. */
export function publicMcpUrl(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.VERITY_MCP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const base = env.BETTER_AUTH_URL?.trim();
  return base ? `${base.replace(/\/+$/, '')}/mcp` : null;
}
