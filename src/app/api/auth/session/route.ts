import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth, getRole, requireBetterAuthRuntime } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SESSION_COOKIE_NAMES = ['session_token', 'session_data', 'dont_remember'].flatMap((name) => [
  `better-auth.${name}`,
  `__Secure-better-auth.${name}`,
]);

function hasSessionCookie(requestHeaders: Headers) {
  const cookie = requestHeaders.get('cookie') || '';
  return /(^|;\s*)(__Secure-)?better-auth\.session_token=/.test(cookie);
}

function unauthenticated(clearCookies: boolean) {
  const response = NextResponse.json({ authenticated: false, user: null });
  if (clearCookies) {
    for (const name of SESSION_COOKIE_NAMES) {
      response.cookies.set(name, '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        sameSite: 'lax',
        secure: name.startsWith('__Secure-'),
      });
    }
  }
  return response;
}

export async function GET() {
  const requestHeaders = await headers();
  try {
    requireBetterAuthRuntime();
    const session = await auth.api.getSession({ headers: requestHeaders, query: { disableCookieCache: true } });
    if (!session?.user) return unauthenticated(hasSessionCookie(requestHeaders));
    return NextResponse.json({
      authenticated: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        role: getRole((session.user as { role?: unknown }).role) || 'viewer',
      },
    });
  } catch {
    return unauthenticated(false);
  }
}
