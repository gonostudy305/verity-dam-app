import type { NextRequest } from 'next/server';

import { getRole, type VerityRole } from '@/lib/auth';
import { ApiError } from './http';
import { requireNativeDatabase } from './native-db';

export type InternalServiceActor = { id: string; email: string; role: VerityRole };

/** Authenticates internal consumers without trusting a caller-provided role. */
export async function requireInternalServiceActor(request: NextRequest, allowedRoles: VerityRole[] = ['contributor', 'reviewer', 'admin']): Promise<InternalServiceActor> {
  const expectedKey = process.env.VERITY_INTERNAL_SERVICE_KEY?.trim();
  const suppliedKey = request.headers.get('x-internal-service-key') || '';
  if (!expectedKey) throw new ApiError(503, 'SERVICE_KEY_UNCONFIGURED', 'VERITY_INTERNAL_SERVICE_KEY must be configured.');
  if (!suppliedKey || suppliedKey !== expectedKey) throw new ApiError(401, 'UNAUTHORIZED_INTERNAL_SERVICE', 'Invalid or missing internal service key.');
  const actorId = request.headers.get('x-actor-user-id') || '';
  if (!actorId) throw new ApiError(400, 'ACTOR_USER_ID_REQUIRED', 'Missing x-actor-user-id header.');
  const result = await requireNativeDatabase().query<{ id: string; email: string; role: string }>(
    `select id, email, role from public."user" where id = $1 limit 1`, [actorId]
  );
  const user = result.rows[0];
  const role = getRole(user?.role);
  if (!user || !role || !allowedRoles.includes(role)) throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Actor is not allowed to use this internal endpoint.');
  return { id: user.id, email: user.email, role };
}

