import { nativeQuery } from './native-db';

export type AuthAuditEventType = 'login_success' | 'login_failure' | 'logout';

export type AuthAuditRequestContext = {
  path?: string;
  headers?: Headers;
  body?: unknown;
  context?: unknown;
};

export type AuthAuditEventInput = {
  eventType: AuthAuditEventType;
  userId?: string | null;
  email?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestPath?: string | null;
  failureCode?: string | null;
  metadata?: Record<string, unknown>;
};

const MAX_EMAIL_LENGTH = 320;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_IP_LENGTH = 128;
const MAX_USER_AGENT_LENGTH = 1024;
const MAX_PATH_LENGTH = 256;
const MAX_FAILURE_CODE_LENGTH = 128;

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function normalizeAuditEmail(value: unknown): string | null {
  const email = boundedText(value, MAX_EMAIL_LENGTH);
  return email ? email.toLowerCase() : null;
}

function requestIp(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const forwarded = boundedText(headers.get('x-forwarded-for'), MAX_IP_LENGTH);
  if (forwarded) return forwarded.split(',')[0]?.trim().slice(0, MAX_IP_LENGTH) || null;
  return (
    boundedText(headers.get('cf-connecting-ip'), MAX_IP_LENGTH) ||
    boundedText(headers.get('x-real-ip'), MAX_IP_LENGTH)
  );
}

export function authAuditRequestDetails(context?: AuthAuditRequestContext) {
  return {
    ipAddress: requestIp(context?.headers),
    userAgent: boundedText(context?.headers?.get('user-agent'), MAX_USER_AGENT_LENGTH),
    requestPath: boundedText(context?.path, MAX_PATH_LENGTH) || '',
  };
}

export function authAuditEmailFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('email' in body)) return null;
  return normalizeAuditEmail((body as { email?: unknown }).email);
}

export function authAuditFailureCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { code?: unknown; errorCode?: unknown; statusCode?: unknown };
  const raw = candidate.code ?? candidate.errorCode ?? candidate.statusCode;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw).slice(0, MAX_FAILURE_CODE_LENGTH);
  return boundedText(raw, MAX_FAILURE_CODE_LENGTH);
}

export function authAuditResponseStatus(value: unknown): number | null {
  if (value instanceof Response) return value.status;
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { status?: unknown; statusCode?: unknown };
  const status = candidate.statusCode ?? candidate.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

/**
 * Persist one security event without making the authentication request fail
 * when the audit table is temporarily unavailable. The event payload is
 * intentionally explicit so credentials and tokens cannot be forwarded by
 * accident.
 */
export async function recordAuthAuditEvent(event: AuthAuditEventInput): Promise<void> {
  const email = normalizeAuditEmail(event.email);
  const sessionId = boundedText(event.sessionId, MAX_SESSION_ID_LENGTH);
  const ipAddress = boundedText(event.ipAddress, MAX_IP_LENGTH);
  const userAgent = boundedText(event.userAgent, MAX_USER_AGENT_LENGTH);
  const requestPath = boundedText(event.requestPath, MAX_PATH_LENGTH) || '';
  const failureCode = boundedText(event.failureCode, MAX_FAILURE_CODE_LENGTH);

  try {
    await nativeQuery(
      `insert into public.auth_audit_events
        (event_type, user_id, email, session_id, ip_address, user_agent, request_path, failure_code, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        event.eventType,
        event.userId || null,
        email,
        sessionId,
        ipAddress,
        userAgent,
        requestPath,
        failureCode,
        JSON.stringify(event.metadata || {}),
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown audit persistence error';
    console.error('[auth-audit] failed to persist event', { eventType: event.eventType, message });
  }
}
