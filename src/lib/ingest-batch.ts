import { isUuid, ValidationError } from '@/lib/media-api';

/** Một dòng kết quả GROUP BY của truy vấn tiến độ lô. */
export interface BatchStatusRow {
  ingest_status: string;
  is_duplicate: boolean;
  has_sku: boolean;
  /** Postgres trả count dạng bigint/chuỗi; được ép về số nguyên khi tổng hợp. */
  n: number;
}

export interface BatchSummary {
  total: number;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  /** blocked + mọi trạng thái lạ: cần người kiểm tra, không được bỏ sót. */
  blocked: number;
  duplicates: number;
  with_sku: number;
  without_sku: number;
  /** Không còn ảnh queued/processing (và lô có ít nhất một ảnh). */
  finished: boolean;
}

export function parseBatchId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!isUuid(value)) throw new ValidationError('Mã lô không hợp lệ.');
  return value;
}

export function buildBatchSummary(rows: BatchStatusRow[]): BatchSummary {
  const summary: BatchSummary = {
    total: 0, queued: 0, processing: 0, ready: 0, failed: 0, blocked: 0,
    duplicates: 0, with_sku: 0, without_sku: 0, finished: false,
  };
  for (const row of rows) {
    const n = Math.max(0, Math.trunc(Number(row.n)) || 0);
    summary.total += n;
    if (row.ingest_status === 'queued') summary.queued += n;
    else if (row.ingest_status === 'processing') summary.processing += n;
    else if (row.ingest_status === 'ready') summary.ready += n;
    else if (row.ingest_status === 'failed') summary.failed += n;
    else summary.blocked += n;
    if (row.is_duplicate) summary.duplicates += n;
    if (row.has_sku) summary.with_sku += n;
    else summary.without_sku += n;
  }
  summary.finished = summary.total > 0 && summary.queued === 0 && summary.processing === 0;
  return summary;
}

/** Còn upload thì luôn poll; xong upload thì poll tới khi lô finished, lô rỗng thì dừng. */
export function shouldKeepPolling(summary: BatchSummary, uploading: boolean): boolean {
  if (uploading) return true;
  return summary.total > 0 && !summary.finished;
}

/**
 * Phần trăm ảnh đã xử lý xong (ready/failed/blocked). Mẫu số lấy số lớn hơn giữa
 * ảnh đã có trong DB và số ảnh dự kiến, vì ảnh chỉ xuất hiện khi từng lô upload xong.
 */
export function batchProgressPercent(summary: BatchSummary, expectedTotal: number): number {
  const denominator = Math.max(summary.total, expectedTotal, 0);
  if (denominator === 0) return 0;
  const settled = summary.ready + summary.failed + summary.blocked;
  return Math.min(100, Math.round((settled / denominator) * 100));
}
