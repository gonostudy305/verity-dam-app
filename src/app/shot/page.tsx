'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { Target, Camera, Plus, RefreshCw, AlertCircle, UserCheck, CheckCircle2, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import type { MissingShot } from '@/app/api/shot/route';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

type StatusFilter = 'open' | 'assigned' | 'all';

const STATUS_LABELS: Record<string, string> = {
  open: 'Chưa chụp',
  assigned: 'Đã phân công',
  completed: 'Hoàn thành',
};

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-bad-soft text-bad border-bad/20',
  assigned: 'bg-warn-soft text-warn border-warn/20',
  completed: 'bg-ok-soft text-ok border-ok/20',
};

export default function ShotPage() {
  const { showToast } = useToast();
  const [shots, setShots] = useState<MissingShot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [isDemo, setIsDemo] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchShots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/shot?status=${filter}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setShots(body.data ?? []);
      setIsDemo(body.mode === 'demo');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lỗi tải dữ liệu');
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchShots();
  }, [fetchShots]);

  const openCount = shots.filter((s) => s.status === 'open').length;

  const handleTransition = async (shot: MissingShot, action: 'assign' | 'complete' | 'reopen') => {
    if (busyId) return;
    setBusyId(shot.id);
    try {
      const res = await apiRequest<{ data: MissingShot }>(`/api/shot/${shot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      // If the current filter no longer matches the new status, drop it from
      // view instead of leaving a stale row until the next manual refresh.
      setShots((prev) => {
        const next = prev.map((s) => (s.id === shot.id ? res.data : s));
        return filter === 'all' ? next : next.filter((s) => s.status === filter);
      });
      showToast(
        action === 'assign' ? 'Đã nhận việc' : action === 'complete' ? 'Đã đánh dấu hoàn thành' : 'Đã mở lại yêu cầu',
        'success'
      );
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        showToast('Bạn cần quyền Contributor trở lên để cập nhật Shot List.', 'warn');
      } else {
        showToast(requestError instanceof Error ? requestError.message : 'Không thể cập nhật yêu cầu.', 'warn');
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppShell
      title="Cần ảnh (Shot List)"
      subtitle={loading ? 'Đang tải...' : `${shots.length} SKU ${filter === 'open' ? 'chưa có ảnh' : ''} cần chụp bổ sung`}
    >
      <div className="mx-auto max-w-[1000px] space-y-4 p-3 sm:p-6">
        {/* Header bar */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="min-w-0">
            <h3 className="text-[15px] font-bold text-text-1">
              Bảng tự sinh theo nhu cầu kinh doanh & marketing
            </h3>
            <p className="text-[12px] text-text-2">
              SKU bán chạy chưa có ảnh công trình, chủ đề content sắp đăng, và mục người dùng tự báo thiếu từ Thư viện.
              {isDemo && (
                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-mono bg-warn-soft text-warn border border-warn/20">
                  DEMO
                </span>
              )}
            </p>
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <button
              type="button"
              onClick={fetchShots}
              disabled={loading}
              aria-label="Làm mới Shot List"
              className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-text-3 transition-all hover:bg-surface-2 disabled:opacity-50"
              title="Làm mới"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <Link
              href="/upload"
              className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-xs transition-all hover:bg-verity-hover sm:flex-none"
            >
              <Camera className="w-4 h-4" />
              <span>Đã chụp, upload ngay</span>
            </Link>
          </div>
        </div>

        {/* Filter tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {(['open', 'assigned', 'all'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`min-h-11 flex-none rounded-lg border px-3 text-[12px] font-semibold transition-all ${
                filter === s
                  ? 'bg-verity text-white border-verity shadow-xs'
                  : 'bg-surface border-border text-text-2 hover:bg-surface-2'
              }`}
            >
              {s === 'open' ? 'Chưa chụp' : s === 'assigned' ? 'Đã phân công' : 'Tất cả'}
            </button>
          ))}
          {openCount > 0 && (
            <span className="ml-auto px-2 py-0.5 rounded-full bg-bad-soft text-bad border border-bad/20 text-[11px] font-mono font-bold">
              {openCount} cần xử lý
            </span>
          )}
        </div>

        {/* Error state */}
        {error && (
          <div className="flex items-center gap-3 p-4 rounded-xl border border-bad/30 bg-bad-soft text-bad text-[13px]">
            <AlertCircle className="w-4 h-4 flex-none" />
            <span>{error}</span>
            <button
              type="button"
              onClick={fetchShots}
              className="ml-auto text-[12px] font-semibold underline"
            >
              Thử lại
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !error && (
          <div className="rounded-xl border border-border bg-surface overflow-hidden divide-y divide-border shadow-xs">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between p-4 animate-shimmer">
                <div className="space-y-2">
                  <div className="h-4 w-32 rounded bg-surface-2" />
                  <div className="h-3 w-64 rounded bg-surface-2" />
                </div>
                <div className="h-8 w-28 rounded-lg bg-surface-2" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && shots.length === 0 && (
          <div className="flex flex-col items-center justify-center p-12 text-center rounded-xl border border-border bg-surface">
            <div className="w-12 h-12 rounded-full bg-ok-soft border border-ok/20 grid place-items-center mb-3">
              <Target className="w-5 h-5 text-ok" />
            </div>
            <p className="text-[14px] font-bold text-text-1 mb-1">
              {filter === 'open' ? 'Không có yêu cầu nào cần chụp' : 'Không có kết quả'}
            </p>
            <p className="text-[12px] text-text-3">
              {filter === 'open' ? 'Kho ảnh đang đầy đủ cho các SKU bán chạy.' : 'Thử đổi bộ lọc khác.'}
            </p>
          </div>
        )}

        {/* Shot list */}
        {!loading && !error && shots.length > 0 && (
          <div className="rounded-xl border border-border bg-surface overflow-hidden divide-y divide-border shadow-xs">
            {shots.map((shot) => (
              <div
                key={shot.id}
                className="flex flex-col gap-3 p-3 transition-colors hover:bg-surface-2/60 sm:flex-row sm:items-center sm:justify-between sm:p-4"
              >
                <div className="min-w-0 flex-1 space-y-1.5 sm:mr-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[13px] font-bold text-text-1">{shot.sku}</span>
                    {shot.brand && (
                      <span className="text-[11.5px] font-semibold px-2 py-0.5 rounded bg-surface-2 text-text-2 border border-border">
                        {shot.brand}
                      </span>
                    )}
                    <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded border ${STATUS_COLORS[shot.status] ?? ''}`}>
                      {STATUS_LABELS[shot.status] ?? shot.status}
                    </span>
                    {shot.query_origin && (
                      <span className="text-[10.5px] font-mono text-text-3 bg-surface-2 px-1.5 py-0.5 rounded border border-border">
                        tìm: "{shot.query_origin}"
                      </span>
                    )}
                  </div>
                  <p className="text-[12.5px] text-text-2 leading-snug">{shot.reason}</p>
                </div>

                <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:flex-none">
                  <Link
                    href={`/upload?sku=${encodeURIComponent(shot.sku)}`}
                    className="flex min-h-11 flex-1 items-center justify-center rounded-lg border border-border px-3.5 text-[12px] font-semibold text-text-1 shadow-xs transition-all hover:bg-surface-2 sm:flex-none"
                  >
                    Upload ảnh
                  </Link>
                  {shot.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => handleTransition(shot, 'assign')}
                      disabled={busyId === shot.id}
                      title="Nhận việc"
                      aria-label="Nhận việc"
                      className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-text-2 transition-all hover:bg-surface-2 hover:text-verity disabled:opacity-50"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {(shot.status === 'open' || shot.status === 'assigned') && (
                    <button
                      type="button"
                      onClick={() => handleTransition(shot, 'complete')}
                      disabled={busyId === shot.id}
                      title="Đánh dấu hoàn thành"
                      aria-label="Đánh dấu hoàn thành"
                      className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-text-2 transition-all hover:bg-surface-2 hover:text-ok disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {(shot.status === 'assigned' || shot.status === 'completed') && (
                    <button
                      type="button"
                      onClick={() => handleTransition(shot, 'reopen')}
                      disabled={busyId === shot.id}
                      title="Mở lại"
                      aria-label="Mở lại"
                      className="grid min-h-11 min-w-11 place-items-center rounded-lg border border-border text-text-2 transition-all hover:bg-surface-2 hover:text-warn disabled:opacity-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Report missing shot CTA */}
        <div className="flex items-center justify-center pt-2">
          <Link
            href="/library"
            className="flex items-center gap-1.5 text-[12px] text-text-3 hover:text-verity transition-colors"
          >
            <Plus className="w-3 h-3" />
            <span>Báo thiếu ảnh từ Thư viện → nút "Báo thiếu ảnh này"</span>
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
