import { NextRequest, NextResponse } from 'next/server';
import { APIError } from 'better-auth/api';

import { auth, getRole, requireBetterAuthRuntime } from '@/lib/auth';
import { ApiError, errorResponse } from '@/lib/server/http';
import { getInternalTestAccountCredentials } from '@/lib/server/internal-test-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function copyAuthHeaders(source: Headers, target: NextResponse) {
  const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (getSetCookie) {
    getSetCookie.call(source).forEach((value) => target.headers.append('set-cookie', value));
    return;
  }
  const value = source.get('set-cookie');
  if (value) target.headers.set('set-cookie', value);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    let email = typeof body.email === 'string' ? body.email.trim() : '';
    let password = typeof body.password === 'string' ? body.password : '';

    if (typeof body.accountKey === 'string' && body.accountKey.trim()) {
      const testAccount = getInternalTestAccountCredentials(body.accountKey);
      if (!testAccount) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Tài khoản kiểm thử không khả dụng.');
      }
      email = testAccount.email;
      password = testAccount.password;
    }

    if (!email || !password) {
      throw new ApiError(400, 'INVALID_CREDENTIALS', 'Vui lòng nhập đầy đủ Email và Mật khẩu.');
    }

    requireBetterAuthRuntime();
    const { headers: authHeaders, response } = await auth.api.signInEmail({
      returnHeaders: true,
      headers: request.headers,
      body: { email, password, rememberMe: true },
    });
    const user = response.user;
    const result = NextResponse.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        role: getRole((user as { role?: unknown }).role) || 'viewer',
      },
    });
    copyAuthHeaders(authHeaders, result);
    return result;
  } catch (error) {
    if (error instanceof APIError) {
      return errorResponse(new ApiError(401, 'INVALID_CREDENTIALS', 'Email hoặc mật khẩu không chính xác.'));
    }
    return errorResponse(error);
  }
}
