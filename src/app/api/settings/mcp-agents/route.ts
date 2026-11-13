import { NextRequest, NextResponse } from 'next/server';

import type { McpAgentRole } from '@/lib/mcp-catalog';
import { ApiError, errorResponse } from '@/lib/server/http';
import { generateMcpKey, keyStatus, parseNewKeyInput, type McpKeyStatus } from '@/lib/server/mcp-admin';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { nativeQuery, requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

export interface McpApiKeyRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: McpAgentRole;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  rotatedFromId: string | null;
  calls24h: number;
  status: McpKeyStatus;
  rawKey?: string;
}

type DbKeyRow = Omit<McpApiKeyRow, 'status' | 'rawKey'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEY_COLUMNS = `
  k.id,
  k.user_id as "userId",
  k.name,
  u.email,
  k.role,
  k.key_prefix as "keyPrefix",
  k.created_at as "createdAt",
  k.last_used_at as "lastUsedAt",
  k.revoked_at as "revokedAt",
  k.expires_at as "expiresAt",
  k.rotated_from_id as "rotatedFromId"`;

function withStatus(row: DbKeyRow, rawKey?: string): McpApiKeyRow {
  return { ...row, status: keyStatus(row.revokedAt, row.expiresAt), ...(rawKey ? { rawKey } : {}) };
}

function requireKeyId(request: NextRequest): string {
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !UUID.test(id)) throw new ApiError(400, 'INVALID_INPUT', 'id không hợp lệ.');
  return id;
}

export async function GET() {
  try {
    await requireNativeAdmin();
    const { rows } = await nativeQuery<DbKeyRow>(
      `SELECT ${KEY_COLUMNS},
         (SELECT count(*)::int FROM public.mcp_tool_call_log l
           WHERE l.api_key_id = k.id AND l.created_at > now() - interval '24 hours') AS "calls24h"
       FROM public.mcp_api_keys k
       JOIN public."user" u ON k.user_id = u.id
       ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`
    );
    return NextResponse.json({ data: rows.map((row) => withStatus(row)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireNativeAdmin();
    const input = parseNewKeyInput(await request.json().catch(() => null));

    // Agent identities are separate from people. Never attach a key to (or
    // change the role of) an account that can sign in to the web app.
    const { rows: existing } = await nativeQuery<{ id: string; hasLogin: boolean }>(
      `SELECT u.id, EXISTS (SELECT 1 FROM public.account a WHERE a."userId" = u.id) AS "hasLogin"
       FROM public."user" u WHERE lower(u.email) = $1 LIMIT 1`,
      [input.email]
    );
    if (existing[0]?.hasLogin) {
      throw new ApiError(
        409,
        'EMAIL_BELONGS_TO_USER',
        'Email này là tài khoản đăng nhập web của một người dùng. Hãy dùng email riêng cho agent (vd: agenthub-agent@veritydam.example).'
      );
    }

    let userId = existing[0]?.id;
    if (!userId) {
      const { rows } = await nativeQuery<{ id: string }>(
        `INSERT INTO public."user" (id, name, email, role, "emailVerified", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, true, now(), now())
         RETURNING id`,
        [input.name, input.email, input.role]
      );
      userId = rows[0].id;
    }

    const key = generateMcpKey();
    const { rows } = await nativeQuery<{ id: string }>(
      `INSERT INTO public.mcp_api_keys (user_id, name, key_prefix, key_hash, role, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now(),
               CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
       RETURNING id`,
      [userId, input.name, key.keyPrefix, key.keyHash, input.role, input.expiresInDays]
    );

    const { rows: created } = await nativeQuery<DbKeyRow>(
      `SELECT ${KEY_COLUMNS}, 0 AS "calls24h"
       FROM public.mcp_api_keys k JOIN public."user" u ON k.user_id = u.id WHERE k.id = $1`,
      [rows[0].id]
    );
    return NextResponse.json({ data: withStatus(created[0], key.rawKey) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH ?id=…  body {action:'rotate'}: new secret, same agent/role/lifetime; old key revoked atomically. */
export async function PATCH(request: NextRequest) {
  let id: string;
  try {
    await requireNativeAdmin();
    id = requireKeyId(request);
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    if (body?.action !== 'rotate') throw new ApiError(400, 'INVALID_ACTION', 'action phải là "rotate".');
  } catch (error) {
    return errorResponse(error);
  }

  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const { rows: oldRows } = await client.query<{ user_id: string; name: string; role: string; lifetime: string | null }>(
      `SELECT user_id, name, role,
              CASE WHEN expires_at IS NULL THEN NULL ELSE (expires_at - created_at)::text END AS lifetime
       FROM public.mcp_api_keys
       WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       FOR UPDATE`,
      [id]
    );
    if (!oldRows[0]) throw new ApiError(409, 'KEY_NOT_ACTIVE', 'Chỉ xoay được key đang hoạt động (chưa thu hồi, chưa hết hạn).');
    const old = oldRows[0];

    const key = generateMcpKey();
    const { rows: newRows } = await client.query<{ id: string }>(
      `INSERT INTO public.mcp_api_keys (user_id, name, key_prefix, key_hash, role, created_at, expires_at, rotated_from_id)
       VALUES ($1, $2, $3, $4, $5, now(), CASE WHEN $6::interval IS NULL THEN NULL ELSE now() + $6::interval END, $7)
       RETURNING id`,
      [old.user_id, old.name, key.keyPrefix, key.keyHash, old.role, old.lifetime, id]
    );
    await client.query(`UPDATE public.mcp_api_keys SET revoked_at = now() WHERE id = $1`, [id]);
    const { rows: created } = await client.query<DbKeyRow>(
      `SELECT ${KEY_COLUMNS}, 0 AS "calls24h"
       FROM public.mcp_api_keys k JOIN public."user" u ON k.user_id = u.id WHERE k.id = $1`,
      [newRows[0].id]
    );
    await client.query('commit');
    return NextResponse.json({ data: withStatus(created[0], key.rawKey) });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    return errorResponse(error);
  } finally {
    client.release();
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireNativeAdmin();
    const id = requireKeyId(request);

    // Soft revoke keeps the audit trail intact.
    const { rowCount } = await nativeQuery(
      `UPDATE public.mcp_api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [id]
    );
    if (!rowCount) {
      const { rows } = await nativeQuery(`SELECT id FROM public.mcp_api_keys WHERE id = $1`, [id]);
      if (rows.length > 0) {
        return NextResponse.json({ data: { revoked: id, message: 'Key đã được thu hồi trước đó.' } });
      }
      throw new ApiError(404, 'NOT_FOUND', 'API Key không tồn tại.');
    }
    return NextResponse.json({ data: { revoked: id } });
  } catch (error) {
    return errorResponse(error);
  }
}
