'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCw, CheckCircle2, XCircle, Shield, AlertTriangle, RotateCcw, Clock } from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface DependencyStatus {
  id: string;
  name: string;
  configured: boolean;
  detail: string;
}

interface AttentionJob {
  id: string;
  media_asset_id: string;
  job_kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error_message: string | null;
  updated_at: string;
}

interface SystemHealth {
  dependencies: DependencyStatus[];
  ingest_jobs: {
    by_status: Record<string, number>;
    oldest_queued_age_seconds: number | null;
    attention_needed: AttentionJob[];
  };
  publish: { by_status: Record<string, number> };
  checked_at: string;
}

const JOB_STATUS_LABELS: Record<string, string> = {
  queued: 'Đang chờ', processing: 'Đang xử lý', succeeded: 'Thành công',
  failed: 'Thất bại', blocked: 'Bị chặn', cancelled: 'Đã huỷ',
};
const PUBLISH_STATUS_LABELS: Record<string, string> = {
  not_requested: 'Chưa yêu cầu', queued: 'Đang xử lý', published: 'Đã xuất bản', failed: 'Thất bại',
};

function formatAgeSeconds(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} phút`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} giờ`;
  return `${Math.round(seconds / 86400)} ngày`;
}

/** Batch 4: this used to render a hardcoded array of 4 "integrations"
 * (Verity-CRM, Legacy Warranty, PostgreSQL pgvector, 9Router Gateway) all
 * permanently marked "online" with fake latency/lastSync values, and a
 * "Kiểm tra lại" button that only ran a setTimeout. Two of those four rows
 * (Verity-CRM, Legacy Warranty) had zero backing integration code anywhere in
 * this repo. Now sourced entirely from GET /api/admin/system-health, which
 * reports only real, already-computed signals -- a `configured` flag per
 * dependency (never a fabricated "online"/latency), live media_ingest_jobs
 * counts, and live media_assets.publish_status counts. */
export function IntegrationSettings() {
  const { showToast } = useToast();
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<SystemHealth>('/api/admin/system-health');
      setHealth(response);
      if (isRefresh) showToast('Đã kiểm tra lại toàn bộ kết nối hệ thống', 'success');
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        setForbidden(true);
      } else {
        setError(requestError instanceof Error ? requestError.message : 'Không thể tải trạng thái hệ thống.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const handleRetry = async (job: AttentionJob) => {
    if (retryingId) return;
    setRetryingId(job.id);
    try {
      await apiRequest(`/api/admin/ingest-jobs/${job.id}/retry`, { method: 'POST' });
      showToast('Đã đưa job trở lại hàng chờ xử lý.', 'success');
      await load(false);
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể thử lại job này.', 'warn');
    } finally {
      setRetryingId(null);
    }
  };

  if (forbidden) {
    return (
      <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs">
        <div className="flex items-start gap-2.5 text-[12.5px] text-text-3">
          <Shield className="w-4 h-4 text-warn flex-none mt-0.5" />
          <span>Bạn cần quyền Admin để xem trạng thái hệ thống.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-5">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-ok-soft border border-ok-border flex items-center justify-center flex-none mt-0.5">
            <Database className="w-4 h-4 text-ok" />
          </div>
          <div>
            <div className="text-[14px] font-bold text-text-1">Trạng thái hệ thống</div>
            <p className="text-[11.5px] text-text-3 mt-0.5">Dữ liệu thật từ cấu hình & hàng chờ xử lý -- không có số liệu giả lập.</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-surface-2 text-[12px] font-semibold text-text-2 hover:text-text-1 hover:bg-hover transition-all disabled:opacity-60"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          <span>Kiểm tra lại</span>
        </button>
      </div>

      {loading ? (
        <div className="text-[13px] text-text-3 p-4">Đang tải…</div>
      ) : error ? (
        <div className="p-4 rounded-2xl border border-warn-border bg-warn-soft/70 text-[13px] text-warn space-y-2">
          <p>{error}</p>
          <button type="button" onClick={() => void load(false)} className="px-3 py-1.5 rounded-lg border border-warn-border hover:bg-warn-soft text-[12px] font-semibold transition-all">
            Thử lại
          </button>
        </div>
      ) : health ? (
        <>
          {/* ── Dependency Status Grid ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {health.dependencies.map((item) => (
              <div key={item.id} className="p-4 rounded-xl border border-border bg-surface-2/40 flex flex-col justify-between gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-bold text-[13.5px] text-text-1">{item.name}</div>
                  <span className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold flex-none border ${
                    item.configured ? 'bg-ok-soft text-ok border-ok-border' : 'bg-surface-2 text-text-3 border-border'
                  }`}>
                    {item.configured ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    {item.configured ? 'Đã cấu hình' : 'Chưa cấu hình'}
                  </span>
                </div>
                <div className="text-[11.5px] text-text-3 border-t border-border-subtle pt-2.5 font-mono truncate" title={item.detail}>
                  {item.detail}
                </div>
              </div>
            ))}
          </div>

          {/* ── Ingest Job Queue ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">Hàng chờ xử lý ảnh (media_ingest_jobs)</h4>
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(health.ingest_jobs.by_status).map(([status, count]) => (
                <span
                  key={status}
                  className={`text-[11px] font-mono font-semibold px-2.5 py-1 rounded-lg border ${
                    (status === 'failed' || status === 'blocked') && count > 0
                      ? 'bg-bad-soft text-bad border-bad-border'
                      : 'bg-surface-2 text-text-2 border-border'
                  }`}
                >
                  {JOB_STATUS_LABELS[status] || status}: {count}
                </span>
              ))}
              <span className="text-[11px] text-text-3 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                Job chờ lâu nhất: {formatAgeSeconds(health.ingest_jobs.oldest_queued_age_seconds)}
              </span>
            </div>

            {health.ingest_jobs.attention_needed.length > 0 ? (
              <div className="space-y-1.5 pt-1">
                {health.ingest_jobs.attention_needed.map((job) => (
                  <div key={job.id} className="p-2.5 rounded-lg border border-bad-border bg-bad-soft/40 flex items-start justify-between gap-3 text-[12px]">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-1.5 font-semibold text-text-1">
                        <AlertTriangle className="w-3.5 h-3.5 text-bad flex-none" />
                        <span>{job.job_kind}</span>
                        <span className="text-[10.5px] font-mono text-text-3">({JOB_STATUS_LABELS[job.status] || job.status} · {job.attempts}/{job.max_attempts} lần thử)</span>
                      </div>
                      {job.error_message ? <p className="text-text-3 truncate" title={job.error_message}>{job.error_message}</p> : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRetry(job)}
                      disabled={retryingId === job.id}
                      className="flex-none h-[28px] px-2.5 rounded-lg border border-border bg-surface text-text-2 hover:text-text-1 hover:bg-hover disabled:opacity-60 text-[11px] font-semibold flex items-center gap-1 transition-all"
                    >
                      <RotateCcw className={`w-3 h-3 ${retryingId === job.id ? 'animate-spin' : ''}`} />
                      Thử lại
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          {/* ── WordPress Publish Lifecycle ── */}
          <div className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">Xuất bản WordPress (media_assets.publish_status)</h4>
            <div className="flex flex-wrap items-center gap-2">
              {Object.entries(health.publish.by_status).map(([status, count]) => (
                <span key={status} className="text-[11px] font-mono font-semibold px-2.5 py-1 rounded-lg border bg-surface-2 text-text-2 border-border">
                  {PUBLISH_STATUS_LABELS[status] || status}: {count}
                </span>
              ))}
            </div>
          </div>

          <p className="text-[10.5px] text-text-disabled font-mono">Cập nhật lúc {new Date(health.checked_at).toLocaleString('vi-VN')}</p>
        </>
      ) : null}

      {/* ── System Governance & Quota Note ── */}
      <div className="p-3.5 rounded-xl border border-border bg-surface-2/60 space-y-2 text-[12px]">
        <div className="flex items-center gap-2 font-semibold text-text-1">
          <Shield className="w-4 h-4 text-verity" />
          <span>Quyền hạn & Bảo mật</span>
        </div>
        <p className="text-text-3 leading-relaxed">
          Dữ liệu hình ảnh và nhãn được bảo vệ bởi kiểm tra quyền server-side trên PostgreSQL. Nhân viên chỉ xem được tài sản trong quyền hạn được cấp phép.
        </p>
      </div>
    </div>
  );
}
