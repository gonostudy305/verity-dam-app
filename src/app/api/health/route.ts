import { NextResponse } from 'next/server';
import { requireBetterAuthRuntime } from '@/lib/auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { getR2Bucket } from '@/lib/server/r2';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    requireBetterAuthRuntime();
    const schema = await requireNativeDatabase().query<{ user_table: string | null; media_table: string | null }>(
      `select to_regclass('public."user"')::text as user_table, to_regclass('public.media_assets')::text as media_table`
    );
    if (!schema.rows[0]?.user_table || !schema.rows[0]?.media_table) throw new Error('native schema is not migrated');
    getR2Bucket();
    return NextResponse.json({ status: 'ok', service: 'verity-media-web', timestamp: new Date().toISOString() });
  } catch {
    return NextResponse.json({ status: 'degraded', service: 'verity-media-web', timestamp: new Date().toISOString() }, { status: 503 });
  }
}
