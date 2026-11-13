import { toNextJsHandler } from 'better-auth/next-js';

import { auth, requireBetterAuthRuntime } from '@/lib/auth';
import { isProvisioningTokenValid, isSignUpPath } from '@/lib/server/auth-provisioning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = toNextJsHandler(auth);

function isEmailSignUpRequest(request: Request): boolean {
  return isSignUpPath(new URL(request.url).pathname);
}

function registrationDisabledResponse(): Response {
  return Response.json(
    { error: 'REGISTRATION_DISABLED', message: 'Tài khoản được cấp bởi quản trị viên Verity.' },
    { status: 403 },
  );
}

export async function GET(request: Request) {
  requireBetterAuthRuntime();
  return handler.GET(request);
}

export async function POST(request: Request) {
  requireBetterAuthRuntime();
  if (isEmailSignUpRequest(request) && !isProvisioningTokenValid(request.headers.get('x-verity-provisioning-token'), process.env.VERITY_AUTH_PROVISIONING_TOKEN)) {
    return registrationDisabledResponse();
  }
  return handler.POST(request);
}
