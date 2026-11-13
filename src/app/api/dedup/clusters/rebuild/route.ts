import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { rebuildDedupClusters } from '@/lib/server/dedup-clusters';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const { user } = await requireNativeReviewer();
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      const data = await rebuildDedupClusters(client, user.id);
      await client.query('commit');
      return NextResponse.json({ success: true, data });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  } catch (error) {
    return errorResponse(error);
  }
}
