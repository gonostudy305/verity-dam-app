import { timingSafeEqual } from 'node:crypto';

export function isProvisioningTokenValid(providedToken: string | null, expectedToken: string | undefined): boolean {
  if (!providedToken || !expectedToken) return false;
  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function isSignUpPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '');
  return (
    normalized === '/api/auth/sign-up/email' ||
    normalized.endsWith('/sign-up/email') ||
    normalized.endsWith('/sign-up')
  );
}
