import { NextResponse } from 'next/server';

import { auth, requireBetterAuthRuntime } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    requireBetterAuthRuntime();
    const { headers: authHeaders } = await auth.api.signOut({
      returnHeaders: true,
      headers: request.headers,
    });
    const response = NextResponse.json({ success: true });
    const getSetCookie = (authHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    if (getSetCookie) {
      getSetCookie.call(authHeaders).forEach((value) => response.headers.append('set-cookie', value));
    } else {
      const value = authHeaders.get('set-cookie');
      if (value) response.headers.set('set-cookie', value);
    }
    return response;
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
