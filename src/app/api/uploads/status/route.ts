import { NextRequest, NextResponse } from 'next/server';

import { isUuid, ValidationError } from '@/lib/media-api';
import { errorResponse } from '@/lib/server/http';
import { nativeQuery } from '@/lib/server/native-db';
import { requireNativeContributor } from '@/lib/server/native-auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const ids = [...new Set(request.nextUrl.searchParams.getAll('id'))];
    if (ids.length === 0 || ids.length > 100 || ids.some((id) => !isUuid(id))) {
      throw new ValidationError('Cần cung cấp từ 1 đến 100 mã asset hợp lệ.');
    }
    const { user, role } = await requireNativeContributor();
    const result = await nativeQuery(
      `select a.id as media_asset_id, a.ingest_status, a.ingest_error,
              q.id as review_queue_id,
              job.job_status, job.job_attempts, job.job_max_attempts, job.job_error
       from public.media_assets a
       left join public.review_queue q on q.media_asset_id = a.id
       left join lateral (
         -- Latest analysis job: retryable worker errors stay in status 'queued'
         -- with the message recorded, so expose them (truncated) to the uploader.
         select j.status as job_status,
                j.attempts as job_attempts,
                j.max_attempts as job_max_attempts,
                left(j.error_message, 200) as job_error
           from public.media_ingest_jobs j
          where j.media_asset_id = a.id
            and j.job_kind = 'analyze_image'
          order by j.created_at desc
          limit 1
       ) job on true
       where a.id = any($1::uuid[])
         and a.deleted_at is null
         and (a.created_by = $2::uuid or $3::boolean)`,
      [ids, user.id, role === 'reviewer' || role === 'admin'],
    );
    return NextResponse.json({ data: result.rows });
  } catch (error) {
    return errorResponse(error);
  }
}
