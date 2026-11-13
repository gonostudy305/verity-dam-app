import { mcp } from '@better-auth/mcp';
import { betterAuth, BetterAuthError, type BetterAuthPlugin } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { Pool } from 'pg';

import { mcpOAuthResource } from '@/lib/mcp-oauth';
import { getNativePool } from '@/lib/server/native-db';
import {
  authAuditEmailFromBody,
  authAuditFailureCode,
  authAuditRequestDetails,
  authAuditResponseStatus,
  recordAuthAuditEvent,
} from '@/lib/server/auth-audit';

const DEV_SECRET = 'verity-dam-development-secret-change-me-32';

function trustedOrigins() {
  const configured = (process.env.VERITY_TRUSTED_ORIGINS || process.env.BETTER_AUTH_URL || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return Array.from(new Set(configured));
}

/**
 * Better Auth runs plugin init once, eagerly, and caches the result: if it
 * rejects, every auth request fails until restart. The OAuth provider's init
 * seeds its resource row in the database, which is unreachable during
 * `next build`, in unit tests, or while Postgres restarts. The provider seeds
 * lazily on first use anyway, so a database failure here is logged, not fatal.
 * Configuration errors (BetterAuthError) still fail fast.
 */
function tolerateInitDatabaseOutage<T extends BetterAuthPlugin>(plugin: T): T {
  const init = plugin.init;
  if (!init) return plugin;
  return {
    ...plugin,
    init: async (ctx) => {
      try {
        return await init(ctx);
      } catch (error) {
        if (error instanceof BetterAuthError) throw error;
        console.error('[auth] MCP OAuth init could not reach the database; resource seed deferred to first use.', error);
        return undefined;
      }
    },
  };
}

const localDevFallback = process.env.NODE_ENV === 'development' && process.env.VERITY_ALLOW_DEV_AUTH_FALLBACK === 'true';
const secret = process.env.BETTER_AUTH_SECRET || (localDevFallback ? DEV_SECRET : 'verity-dam-build-only-secret-not-for-runtime');

// Standard Better Auth configured with PostgreSQL
export const auth = betterAuth({
  database: getNativePool() as Pool,
  secret,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  trustedOrigins: trustedOrigins(),
  // '/token' is the jwt() plugin's session-to-JWT endpoint; MCP clients use
  // the OAuth '/oauth2/token' endpoint instead, so keep it off.
  disabledPaths: ['/get-access-token', '/refresh-token', '/link-social', '/unlink-account', '/token'],
  plugins: [
    // Signs OAuth access tokens (EdDSA); public keys at /api/auth/jwks.
    jwt(),
    // OAuth 2.1 authorization server for the remote MCP server. Access tokens
    // are JWTs bound (aud) to the MCP resource URL; the Python MCP server
    // verifies them against the JWKS and maps `sub` to the user's role.
    tolerateInitDatabaseOutage(mcp({
      resource: mcpOAuthResource(),
      loginPage: '/login',
      consentPage: '/consent',
      // MCP clients (Claude, ChatGPT, VS Code) self-register (RFC 7591).
      // Registration alone grants nothing: tokens still need a user login
      // and explicit consent.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // No client_credentials: every token must act on behalf of a user.
      grantTypes: ['authorization_code', 'refresh_token'],
      accessTokenExpiresIn: 3600,
    })),
  ],
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    minPasswordLength: 8,
  },
  account: {
    encryptOAuthTokens: true,
    accountLinking: { enabled: false },
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'viewer',
        input: false,
      },
    },
  },
  databaseHooks: {
    session: {
      create: {
        after: async (session, context) => {
          const userId = typeof session.userId === 'string' ? session.userId : null;
          const sessionId = typeof session.id === 'string' ? session.id : null;
          if (context?.path !== '/sign-in/email') return;
          await recordAuthAuditEvent({
            eventType: 'login_success',
            userId,
            sessionId,
            ...authAuditRequestDetails(context),
          });
        },
      },
      delete: {
        after: async (session, context) => {
          if (context?.path !== '/sign-out') return;
          await recordAuthAuditEvent({
            eventType: 'logout',
            userId: typeof session.userId === 'string' ? session.userId : null,
            sessionId: typeof session.id === 'string' ? session.id : null,
            ...authAuditRequestDetails(context),
          });
        },
      },
    },
  },
  hooks: {
    after: async (rawContext) => {
      const context = rawContext as unknown as {
        path?: string;
        params?: Record<string, unknown>;
        body?: unknown;
        context?: { returned?: unknown };
        headers?: Headers;
      };
      if (context.path !== '/sign-in/email') return {};
      const returned = context.context?.returned;
      const status = authAuditResponseStatus(returned);
      if (status === null || status < 400) return {};
      await recordAuthAuditEvent({
        eventType: 'login_failure',
        email: authAuditEmailFromBody(context.body),
        failureCode: authAuditFailureCode(returned),
        ...authAuditRequestDetails(context),
        metadata: { status },
      });
      return {};
    },
  },
  advanced: {
    database: {
      generateId: 'uuid',
      joins: true,
    },
  },
});

export type VerityRole = 'viewer' | 'contributor' | 'reviewer' | 'admin';

export function requireBetterAuthRuntime() {
  const allowLocalFallback = process.env.NODE_ENV === 'development' && process.env.VERITY_ALLOW_DEV_AUTH_FALLBACK === 'true';
  if (!allowLocalFallback && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for native PostgreSQL Auth');
  }
  if (!allowLocalFallback && !process.env.BETTER_AUTH_SECRET) {
    throw new Error('BETTER_AUTH_SECRET is required for native PostgreSQL Auth');
  }
}

export function getRole(value: unknown): VerityRole | null {
  return value === 'viewer' || value === 'contributor' || value === 'reviewer' || value === 'admin'
    ? value
    : null;
}
