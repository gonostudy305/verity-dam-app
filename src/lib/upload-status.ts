import type { UploadItem } from '@/types/media';

/** Shape returned by GET /api/uploads/status for each asset. */
export interface UploadProcessingStatus {
  media_asset_id: string;
  ingest_status: UploadItem['processing_state'];
  ingest_error: string | null;
  job_status?: string | null;
  job_attempts?: number | null;
  job_max_attempts?: number | null;
  job_error?: string | null;
}

/** Shown when the browser stops auto-refreshing but the asset is still not finished. */
export const UPLOAD_POLL_TIMEOUT_MESSAGE =
  'Đã dừng tự cập nhật vì chờ quá lâu. Bấm "Kiểm tra lại" để xem trạng thái mới nhất.';

const KNOWN_JOB_ERRORS: Array<[RegExp, string]> = [
  [/Shared Vision configuration is not configured/i, 'AI Vision chưa được cấu hình — admin cần nhập API key trong Cài đặt'],
  [/Shared Embedding configuration is not configured/i, 'Mô hình embedding chưa được cấu hình'],
  [/Shared taxonomy configuration is not configured/i, 'Danh mục phân loại chưa được cấu hình'],
];

/**
 * Human-readable reason an analysis job is waiting. The worker keeps retryable
 * failures (for example missing Vision configuration) in status `queued` with
 * the error recorded, so without this the upload card would look healthy for
 * the whole retry window. Terminal failures are reported through ingest_error.
 */
export function describeJobIssue(
  status: Pick<UploadProcessingStatus, 'job_status' | 'job_attempts' | 'job_max_attempts' | 'job_error'>,
): string | undefined {
  const raw = status.job_error?.trim();
  if (!raw) return undefined;
  if (status.job_status !== 'queued' && status.job_status !== 'processing') return undefined;
  const known = KNOWN_JOB_ERRORS.find(([pattern]) => pattern.test(raw));
  const reason = known ? known[1] : raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
  const attempts = typeof status.job_attempts === 'number' && typeof status.job_max_attempts === 'number'
    ? ` (đã thử ${status.job_attempts}/${status.job_max_attempts}, hệ thống sẽ tự thử lại)`
    : ' (hệ thống sẽ tự thử lại)';
  return `Chưa thể phân tích: ${reason}${attempts}`;
}

/** Fields of an UploadItem derived from one status row. */
export function statusToItemPatch(status: UploadProcessingStatus): Partial<UploadItem> {
  return {
    processing_state: status.ingest_status,
    error: status.ingest_status === 'failed' ? status.ingest_error || 'Không thể xử lý tệp ảnh này.' : undefined,
    job_issue: status.ingest_status === 'queued' || status.ingest_status === 'processing'
      ? describeJobIssue(status)
      : undefined,
  };
}
