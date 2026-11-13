import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { auth } from '@/lib/auth';
import { nativeQuery } from './native-db';

const integrationEnabled = process.env.VERITY_AUTH_INTEGRATION_REQUIRED === '1';

function cookieHeader(headers: Headers): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const values = getSetCookie ? getSetCookie.call(headers) : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  return values.map((value) => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

test('Better Auth PostgreSQL integration: login failure, login, session, logout, and durable audit ledger', { skip: integrationEnabled ? false : 'Set VERITY_AUTH_INTEGRATION_REQUIRED=1 to run against PostgreSQL.' }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the auth integration gate.');
  if (!process.env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required for the auth integration gate.');

  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const email = `auth-integration-${suffix}@example.test`;
  const password = `Verity-${randomUUID()}-Pass!`;
  const requestHeaders = new Headers({
    'user-agent': 'Verity auth integration test',
    'x-forwarded-for': '198.51.100.23',
  });
  let userId: string | null = null;

  try {
    const signup = await auth.api.signUpEmail({
      headers: requestHeaders,
      body: { name: 'Verity Auth Integration', email, password },
    });
    userId = signup.user.id;
    assert.equal(signup.user.email, email);

    await nativeQuery('update public."user" set role = $1, "updatedAt" = now() where id = $2', ['reviewer', userId]);

    await assert.rejects(
      auth.api.signInEmail({
        headers: requestHeaders,
        body: { email, password: `${password}-wrong`, rememberMe: true },
      }),
    );

    const failedAudit = await nativeQuery<{ event_type: string; email: string; ip_address: string; user_agent: string; request_path: string; failure_code: string | null }>(
      `select event_type, email, ip_address, user_agent, request_path, failure_code
         from public.auth_audit_events
        where email = $1 and event_type = 'login_failure'
        order by created_at desc limit 1`,
      [email],
    );
    assert.equal(failedAudit.rows[0]?.event_type, 'login_failure');
    assert.equal(failedAudit.rows[0]?.email, email);
    assert.equal(failedAudit.rows[0]?.ip_address, '198.51.100.23');
    assert.equal(failedAudit.rows[0]?.user_agent, 'Verity auth integration test');
    assert.equal(failedAudit.rows[0]?.request_path, '/sign-in/email');
    assert.notEqual(failedAudit.rows[0]?.failure_code, null);

    const signin = await auth.api.signInEmail({
      returnHeaders: true,
      headers: requestHeaders,
      body: { email, password, rememberMe: true },
    });
    assert.equal(signin.response.user.email, email);
    assert.equal((signin.response.user as { role?: string }).role, 'reviewer');

    const cookie = cookieHeader(signin.headers);
    assert.ok(cookie, 'Better Auth login must return a session cookie.');

    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    assert.equal(session?.user.id, userId);
    assert.equal((session?.user as { role?: string }).role, 'reviewer');

    const successAudit = await nativeQuery<{ event_type: string; user_id: string; session_id: string; request_path: string }>(
      `select event_type, user_id, session_id, request_path
         from public.auth_audit_events
        where user_id = $1 and event_type = 'login_success'
        order by created_at desc limit 1`,
      [userId],
    );
    assert.equal(successAudit.rows[0]?.event_type, 'login_success');
    assert.equal(successAudit.rows[0]?.user_id, userId);
    assert.ok(successAudit.rows[0]?.session_id);
    assert.equal(successAudit.rows[0]?.request_path, '/sign-in/email');

    const activeSession = await nativeQuery<{ count: string }>('select count(*)::text as count from public.session where "userId" = $1', [userId]);
    assert.equal(activeSession.rows[0]?.count, '1');

    const signout = await auth.api.signOut({ returnHeaders: true, headers: new Headers({ cookie }) });
    assert.equal(signout.response.success, true);

    const remainingSession = await nativeQuery<{ count: string }>('select count(*)::text as count from public.session where "userId" = $1', [userId]);
    assert.equal(remainingSession.rows[0]?.count, '0');

    const logoutAudit = await nativeQuery<{ event_type: string; user_id: string; request_path: string }>(
      `select event_type, user_id, request_path
         from public.auth_audit_events
        where user_id = $1 and event_type = 'logout'
        order by created_at desc limit 1`,
      [userId],
    );
    assert.equal(logoutAudit.rows[0]?.event_type, 'logout');
    assert.equal(logoutAudit.rows[0]?.user_id, userId);
    assert.equal(logoutAudit.rows[0]?.request_path, '/sign-out');

    const credentialLeak = await nativeQuery<{ leaked: string }>(
      `select count(*)::text as leaked
         from public.auth_audit_events
        where email = $1
          and (coalesce(metadata::text, '') ilike '%password%'
            or coalesce(metadata::text, '') ilike '%token%')`,
      [email],
    );
    assert.equal(credentialLeak.rows[0]?.leaked, '0');
  } finally {
    if (userId) {
      await nativeQuery('delete from public.auth_audit_events where user_id = $1 or email = $2', [userId, email]);
      await nativeQuery('delete from public."user" where id = $1', [userId]);
    }
  }
});
