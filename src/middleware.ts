import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PROTECTED_PREFIXES = [
  '/review',
  '/library',
  '/duplicates',
  '/upload',
  '/settings',
  '/shot',
  '/spec',
  '/studio',
  '/consent',
];

function getSafeBaseUrl(request: NextRequest): URL {
  const trustedOrigins = (process.env.VERITY_TRUSTED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = (request.headers.get('x-forwarded-proto') || 'https').toLowerCase();

  if (forwardedHost) {
    const candidateHttp = `http://${forwardedHost}`.toLowerCase();
    const candidateHttps = `https://${forwardedHost}`.toLowerCase();
    const candidateDirect = `${forwardedProto}://${forwardedHost}`.toLowerCase();

    // Only accept if candidate strictly matches an explicitly trusted origin
    const matched = trustedOrigins.find(
      (origin) =>
        origin === candidateDirect ||
        origin === candidateHttps ||
        origin === candidateHttp
    );
    if (matched) {
      return new URL(matched);
    }
  }

  return new URL(request.url);
}

function buildRedirect(targetPath: string, request: NextRequest): URL {
  const baseUrl = getSafeBaseUrl(request);
  return new URL(targetPath, baseUrl);
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const sessionToken =
    request.cookies.get('__Secure-better-auth.session_token')?.value ||
    request.cookies.get('better-auth.session_token')?.value;

  const isAuthenticated = Boolean(sessionToken);

  // Root path handling: Default entry point is /login when unauthenticated
  if (pathname === '/') {
    if (isAuthenticated) {
      return NextResponse.redirect(buildRedirect('/library', request));
    }
    return NextResponse.redirect(buildRedirect('/login', request));
  }

  // Login page handling: If already authenticated, redirect to library
  if (pathname === '/login') {
    // OAuth (MCP) sign-in: the provider only sends users here when it found no
    // valid session, so a leftover cookie must not bounce them to /library.
    const isOAuthLogin = request.nextUrl.searchParams.has('sig') && request.nextUrl.searchParams.has('client_id');
    if (isAuthenticated && !isOAuthLogin) {
      const returnUrl = request.nextUrl.searchParams.get('returnUrl');
      const target = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/library';
      return NextResponse.redirect(buildRedirect(target, request));
    }
    return NextResponse.next();
  }

  // Protected pages handling: If unauthenticated, redirect to login with returnUrl
  const isProtected = PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (isProtected && !isAuthenticated) {
    const loginUrl = buildRedirect('/login', request);
    loginUrl.searchParams.set('returnUrl', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/login',
    '/review/:path*',
    '/library/:path*',
    '/duplicates/:path*',
    '/upload/:path*',
    '/settings/:path*',
    '/shot/:path*',
    '/spec/:path*',
    '/studio/:path*',
    '/consent/:path*',
  ],
};
