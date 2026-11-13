import { NextRequest, NextResponse } from 'next/server';

import { buildBatchSummary, parseBatchId, type BatchStatusRow } from '@/lib/ingest-batch';
import { errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { nativeQuery } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ batchId: string }>;
}

/**
 * Tiến độ một lô nhập thư mục. `batch_id` do client sinh và được lưu ở
 * media_assets.origin_info->>'batch_id' bởi /api/uploads/complete.
 * Người thường chỉ thấy lô của chính mình; reviewer/admin thấy mọi lô. Lô của
 * người khác trả về toàn số 0 (không tiết lộ lô có tồn tại hay không).
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const batchId = parseBatchId((await params).batchId);
    const { user, role } = await requireNativeContributor();
    const result = await nativeQuery<BatchStatusRow>(
      `select a.ingest_status,
              coalesce(q.is_duplicate, false) as is_duplicate,
              (a.sku is not null and a.sku <> '') as has_sku,
              count(*)::int as n
         from public.media_assets a
         left join public.review_queue q on q.media_asset_id = a.id
        where a.origin_info->>'batch_id' = $1
          and a.deleted_at is null
          and (a.created_by = $2::uuid or $3::boolean)
        group by 1, 2, 3`,
      [batchId, user.id, role === 'reviewer' || role === 'admin'],
    );
    return NextResponse.json({ data: { batch_id: batchId, ...buildBatchSummary(result.rows) } });
  } catch (error) {
    return errorResponse(error);
  }
}
