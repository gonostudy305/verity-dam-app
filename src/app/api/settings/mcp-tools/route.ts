import { NextRequest, NextResponse } from 'next/server';

import { MCP_TOOLS } from '@/lib/mcp-catalog';
import { ApiError, errorResponse } from '@/lib/server/http';
import { isKnownTool } from '@/lib/server/mcp-admin';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { nativeQuery } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

/** GET: catalog + admin enable switch (missing row = enabled). */
export async function GET() {
  try {
    await requireNativeAdmin();
    const { rows } = await nativeQuery<{ toolName: string; enabled: boolean; updatedAt: string }>(
      `SELECT tool_name AS "toolName", enabled, updated_at AS "updatedAt" FROM public.mcp_tool_settings`
    );
    const byName = new Map(rows.map((row) => [row.toolName, row]));
    const { rows: usage } = await nativeQuery<{ toolName: string; calls: number }>(
      `SELECT tool_name AS "toolName", count(*)::int AS calls
       FROM public.mcp_tool_call_log WHERE created_at > now() - interval '7 days' GROUP BY tool_name`
    );
    const callsByName = new Map(usage.map((row) => [row.toolName, row.calls]));
    return NextResponse.json({
      data: MCP_TOOLS.map((tool) => ({
        ...tool,
        enabled: byName.get(tool.name)?.enabled ?? true,
        updatedAt: byName.get(tool.name)?.updatedAt ?? null,
        calls7d: callsByName.get(tool.name) ?? 0,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** PUT {toolName, enabled}: the MCP server picks the change up within ~15 s. */
export async function PUT(request: NextRequest) {
  try {
    const { user } = await requireNativeAdmin();
    const body = (await request.json().catch(() => null)) as { toolName?: unknown; enabled?: unknown } | null;
    if (!isKnownTool(body?.toolName)) throw new ApiError(400, 'UNKNOWN_TOOL', 'Tool không tồn tại.');
    if (typeof body?.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'enabled phải là true/false.');

    await nativeQuery(
      `INSERT INTO public.mcp_tool_settings (tool_name, enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tool_name) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [body.toolName, body.enabled, user.id]
    );
    return NextResponse.json({ data: { toolName: body.toolName, enabled: body.enabled } });
  } catch (error) {
    return errorResponse(error);
  }
}
