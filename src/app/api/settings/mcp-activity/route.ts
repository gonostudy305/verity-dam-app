import { NextRequest, NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { nativeQuery } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

export interface McpActivityRow {
  id: string;
  toolName: string;
  status: 'success' | 'error';
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  apiKeyId: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  agentEmail: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/settings/mcp-activity?limit=50&keyId=…&status=error */
export async function GET(request: NextRequest) {
  try {
    await requireNativeAdmin();
    const params = new URL(request.url).searchParams;
    const limit = Math.min(200, Math.max(1, Number(params.get('limit')) || 50));
    const keyId = params.get('keyId');
    const status = params.get('status');

    const where: string[] = [];
    const values: unknown[] = [];
    if (keyId && UUID.test(keyId)) {
      values.push(keyId);
      where.push(`l.api_key_id = $${values.length}`);
    }
    if (status === 'success' || status === 'error') {
      values.push(status);
      where.push(`l.status = $${values.length}`);
    }
    values.push(limit);

    const { rows } = await nativeQuery<McpActivityRow>(
      `SELECT l.id, l.tool_name AS "toolName", l.status, l.error_message AS "errorMessage",
              l.duration_ms AS "durationMs", l.created_at AS "createdAt", l.api_key_id AS "apiKeyId",
              k.name AS "keyName", k.key_prefix AS "keyPrefix", u.email AS "agentEmail"
       FROM public.mcp_tool_call_log l
       LEFT JOIN public.mcp_api_keys k ON k.id = l.api_key_id
       LEFT JOIN public."user" u ON u.id = l.bot_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY l.created_at DESC
       LIMIT $${values.length}`,
      values
    );

    const { rows: summary } = await nativeQuery<{ total: number; errors: number; p50: number | null }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'error')::int AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50
       FROM public.mcp_tool_call_log WHERE created_at > now() - interval '24 hours'`
    );

    return NextResponse.json({ data: rows, summary24h: summary[0] });
  } catch (error) {
    return errorResponse(error);
  }
}
