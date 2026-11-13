import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { getR2Bucket } from '@/lib/server/r2';
import { getSharedVisionConfig } from '@/lib/server/vision-config';
import { getSharedEmbeddingConfig } from '@/lib/server/embedding-config';

export const dynamic = 'force-dynamic';

interface DependencyStatus {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
}

const JOB_STATUSES = ['queued', 'processing', 'succeeded', 'failed', 'blocked', 'cancelled'] as const;
const PUBLISH_STATUSES = ['not_requested', 'queued', 'published', 'failed'] as const;

/** Batch 4: replaces the previous IntegrationSettings.tsx, whose entire
 * "4 Online" grid was hardcoded (fake latency, fake "2 phút trước"
 * timestamps, a "Kiểm tra lại" button that only ran a setTimeout) -- 2 of
 * its 4 rows (Verity-CRM, Legacy Warranty) had zero backing code anywhere in
 * this repo. Every field below is either a live DB read or a real
 * `configured` flag already computed by the corresponding config module --
 * nothing here is fabricated or guessed. */
export async function GET() {
  try {
    await requireNativeAdmin();
    const pool = requireNativeDatabase();

    // vision/embedding read a separate config-store table
    // (verity_ai_vision_config / verity_ai_embedding_config) that the codebase
    // itself already treats as possibly-not-ready (configStoreUnavailable()
    // in both config modules) -- caught individually so one missing config
    // store degrades to "unable to check" for that one card instead of
    // 500ing the whole health panel and hiding the DB/R2/job/publish data
    // that's still perfectly readable.
    const [schema, vision, embedding, jobStatusCounts, oldestQueued, attentionJobs, publishCounts] = await Promise.all([
      pool.query<{ user_table: string | null; media_table: string | null }>(
        `select to_regclass('public."user"')::text as user_table, to_regclass('public.media_assets')::text as media_table`
      ),
      getSharedVisionConfig().catch(() => null),
      getSharedEmbeddingConfig().catch(() => null),
      pool.query<{ status: string; count: number }>(
        `select status, count(*)::int as count from public.media_ingest_jobs group by status`
      ),
      pool.query<{ oldest_seconds: number | null }>(
        `select extract(epoch from (now() - min(created_at)))::int as oldest_seconds
           from public.media_ingest_jobs where status = 'queued'`
      ),
      pool.query<{
        id: string; media_asset_id: string; job_kind: string; status: string;
        attempts: number; max_attempts: number; error_message: string | null; updated_at: string;
      }>(
        `select id, media_asset_id, job_kind, status, attempts, max_attempts, error_message, updated_at
           from public.media_ingest_jobs
          where status in ('failed', 'blocked')
          order by updated_at desc
          limit 20`
      ),
      pool.query<{ publish_status: string; count: number }>(
        `select publish_status, count(*)::int as count from public.media_assets where deleted_at is null group by publish_status`
      ),
    ]);

    const dbConfigured = Boolean(schema.rows[0]?.user_table && schema.rows[0]?.media_table);

    let objectStorageConfigured = false;
    try {
      getR2Bucket();
      objectStorageConfigured = true;
    } catch {
      objectStorageConfigured = false;
    }

    const dependencies: DependencyStatus[] = [
      {
        id: 'postgres',
        name: 'PostgreSQL (native)',
        configured: dbConfigured,
        detail: dbConfigured ? 'Schema native đã migrate và truy vấn được.' : 'Chưa migrate schema native hoặc kết nối lỗi.',
      },
      {
        id: 'object_storage',
        name: 'Cloudflare R2 (lưu trữ media)',
        configured: objectStorageConfigured,
        detail: objectStorageConfigured ? 'Đã cấu hình endpoint/bucket/khoá truy cập.' : 'Thiếu biến môi trường R2_*.',
      },
      {
        id: 'ai_vision',
        name: 'AI Vision (caption & OCR)',
        configured: vision?.configured ?? false,
        detail: vision === null
          ? 'Không thể kiểm tra (lỗi truy vấn config store).'
          : vision.configured
            ? `${vision.model} · ${new URL(vision.baseUrl).hostname}`
            : 'Chưa cấu hình trong Cài đặt → AI Vision.',
      },
      {
        id: 'embedding',
        name: 'Embedding provider (SKU & tìm kiếm)',
        configured: embedding?.configured ?? false,
        detail: embedding === null
          ? 'Không thể kiểm tra (lỗi truy vấn config store).'
          : embedding.configured
            ? `${embedding.provider} · ${embedding.model}`
            : 'Chưa cấu hình trong Cài đặt → Embedding.',
      },
    ];

    const jobsByStatus = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<(typeof JOB_STATUSES)[number], number>;
    for (const row of jobStatusCounts.rows) {
      if ((JOB_STATUSES as readonly string[]).includes(row.status)) {
        jobsByStatus[row.status as (typeof JOB_STATUSES)[number]] = row.count;
      }
    }

    const publishByStatus = Object.fromEntries(PUBLISH_STATUSES.map((status) => [status, 0])) as Record<(typeof PUBLISH_STATUSES)[number], number>;
    for (const row of publishCounts.rows) {
      if ((PUBLISH_STATUSES as readonly string[]).includes(row.publish_status)) {
        publishByStatus[row.publish_status as (typeof PUBLISH_STATUSES)[number]] = row.count;
      }
    }

    return NextResponse.json({
      dependencies,
      ingest_jobs: {
        by_status: jobsByStatus,
        oldest_queued_age_seconds: oldestQueued.rows[0]?.oldest_seconds ?? null,
        attention_needed: attentionJobs.rows,
      },
      publish: { by_status: publishByStatus },
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
