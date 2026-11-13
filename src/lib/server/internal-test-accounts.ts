import type { VerityRole } from '@/lib/auth';

export const INTERNAL_TEST_ROLES = ['viewer', 'contributor', 'reviewer', 'admin'] as const satisfies readonly VerityRole[];
export type InternalTestRole = (typeof INTERNAL_TEST_ROLES)[number];

export interface InternalTestAccount {
  key: `system-${InternalTestRole}`;
  role: InternalTestRole;
  label: string;
  description: string;
  email: string;
  name: string;
  password: string;
}

export type PublicInternalTestAccount = Omit<InternalTestAccount, 'password'>;

const ROLE_META: Record<InternalTestRole, { label: string; description: string }> = {
  viewer: { label: 'Viewer', description: 'Xem và tải tài sản đã được cấp quyền' },
  contributor: { label: 'Contributor', description: 'Đóng góp, upload và cập nhật metadata' },
  reviewer: { label: 'Reviewer', description: 'Duyệt metadata, AI và workflow nội dung' },
  admin: { label: 'Admin', description: 'Quản trị hệ thống, policy và vận hành' },
};

function envName(role: InternalTestRole, suffix: 'EMAIL' | 'PASSWORD' | 'NAME'): string {
  return `VERITY_INTERNAL_TEST_${role.toUpperCase()}_${suffix}`;
}

/**
 * Test-account shortcuts are deliberately fail-closed in production. They
 * are for local/staging role verification only; normal production login
 * always remains email/password.
 */
export function isInternalTestAccountsEnabled(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED === 'true';
}

function readAccount(role: InternalTestRole): InternalTestAccount | null {
  const email = process.env[envName(role, 'EMAIL')]?.trim();
  const password = process.env[envName(role, 'PASSWORD')];
  if (!email || !password) return null;

  return {
    key: `system-${role}`,
    role,
    label: ROLE_META[role].label,
    description: ROLE_META[role].description,
    email,
    name: process.env[envName(role, 'NAME')]?.trim() || `Verity System ${ROLE_META[role].label}`,
    password,
  };
}

export function getConfiguredInternalTestAccounts(): PublicInternalTestAccount[] {
  if (!isInternalTestAccountsEnabled()) return [];
  return INTERNAL_TEST_ROLES.flatMap((role) => {
    const account = readAccount(role);
    if (!account) return [];
    const { password: _password, ...publicAccount } = account;
    return [publicAccount];
  });
}

export function getInternalTestAccountCredentials(accountKey: string): InternalTestAccount | null {
  if (!isInternalTestAccountsEnabled()) return null;
  const match = /^(?:system-)?(viewer|contributor|reviewer|admin)$/.exec(accountKey.trim().toLowerCase());
  return match ? readAccount(match[1] as InternalTestRole) : null;
}
