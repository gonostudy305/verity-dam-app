import { NextResponse } from 'next/server';

import {
  getConfiguredInternalTestAccounts,
  isInternalTestAccountsEnabled,
} from '@/lib/server/internal-test-accounts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Returns role shortcuts only for explicitly enabled non-production
 * environments. Passwords never leave the server.
 */
export async function GET() {
  if (!isInternalTestAccountsEnabled()) {
    return NextResponse.json({ enabled: false, data: [] });
  }
  return NextResponse.json({ enabled: true, data: getConfiguredInternalTestAccounts() });
}
