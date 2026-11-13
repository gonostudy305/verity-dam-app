import { headers } from 'next/headers';

import { auth, getRole, type VerityRole, requireBetterAuthRuntime } from '@/lib/auth';
import { ApiError } from './http';

export type NativeAuthContext = {
  user: { id: string; email: string; role?: unknown };
  role: VerityRole;
};

export async function requireNativeRole(allowedRoles: VerityRole[]): Promise<NativeAuthContext> {
  try {
    requireBetterAuthRuntime();
    const session = await auth.api.getSession({ headers: await headers(), query: { disableCookieCache: true } });
    if (!session?.user) {
      throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Bạn cần đăng nhập để dùng VerityDAM.');
    }
    const role = getRole((session.user as { role?: unknown }).role);
    if (!role || !allowedRoles.includes(role)) {
      throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Tài khoản không có quyền thực hiện thao tác này.');
    }
    return {
      user: { id: session.user.id, email: session.user.email, role: (session.user as { role?: unknown }).role },
      role,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && /database|postgres|connection|pool/i.test(error.message)) {
      throw new ApiError(503, 'AUTH_PROVIDER_UNAVAILABLE', 'Auth provider unavailable.');
    }
    throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Bạn cần đăng nhập để dùng VerityDAM.');
  }
}

export function requireNativeMember() {
  return requireNativeRole(['viewer', 'contributor', 'reviewer', 'admin']);
}

export function requireNativeContributor() {
  return requireNativeRole(['contributor', 'reviewer', 'admin']);
}

export function requireNativeReviewer() {
  return requireNativeRole(['reviewer', 'admin']);
}

export function requireNativeAdmin() {
  return requireNativeRole(['admin']);
}
