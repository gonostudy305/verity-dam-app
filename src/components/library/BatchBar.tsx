'use client';

import React from 'react';
import { Download, Tag, X, Loader2, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BatchBarProps {
  selectedCount: number;
  onDownload: () => void;
  onEditTags: () => void;
  onReport: () => void;
  onClearSelection: () => void;
  isDownloading?: boolean;
  archiveStatus?: {
    status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled' | 'expired';
    processedAssets: number;
    totalAssets: number;
    errorMessage?: string | null;
  } | null;
  onCancelDownload?: () => void;
  onRetryDownload?: () => void;
  className?: string;
}

// Batch 7: "Bộ sưu tập" (Add to Collection) was removed here -- it only ever
// showed a fake success toast. There is no Collections data model anywhere
// in this repo (no table, no API route); per the roadmap this batch
// explicitly builds Collections only if a real data model exists, and it
// doesn't, so the honest fix is to remove the button, not fake the action.
export function BatchBar({
  selectedCount,
  onDownload,
  onEditTags,
  onReport,
  onClearSelection,
  isDownloading = false,
  archiveStatus = null,
  onCancelDownload,
  onRetryDownload,
  className,
}: BatchBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        'fixed bottom-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom)+0.75rem)] left-3 right-3 z-[var(--z-action-bar)] flex flex-wrap items-center justify-center gap-2 rounded-2xl border border-border-strong bg-surface p-2 px-3.5 text-[13px] shadow-pop animate-pop select-none md:bottom-6 md:left-1/2 md:right-auto md:-translate-x-1/2',
        className
      )}
    >
      <span className="w-full px-1 text-center font-semibold text-text-1 md:w-auto">
        {selectedCount} ảnh đã chọn
      </span>

      <span className="mx-1 hidden h-5 w-[1px] bg-border md:block" />

      <button
        type="button"
        onClick={onDownload}
        disabled={isDownloading}
        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-text-1 font-semibold shadow-xs transition-all hover:bg-surface-2 disabled:opacity-60"
      >
        {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        <span>Tải về</span>
      </button>

      {archiveStatus && (archiveStatus.status === 'queued' || archiveStatus.status === 'processing') ? (
        <div className="flex w-full items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-2 text-[12px] text-text-2 md:w-auto md:min-w-[230px]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span>{archiveStatus.status === 'queued' ? 'Đang xếp hàng archive' : 'Đang chuẩn bị archive'}</span>
              <span className="font-semibold text-text-1">{archiveStatus.processedAssets}/{archiveStatus.totalAssets}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-verity transition-[width] duration-300"
                style={{ width: `${archiveStatus.totalAssets ? Math.round((archiveStatus.processedAssets / archiveStatus.totalAssets) * 100) : 0}%` }}
              />
            </div>
          </div>
          {onCancelDownload ? (
            <button type="button" onClick={onCancelDownload} className="min-h-9 rounded-md px-2 font-semibold text-text-3 hover:bg-hover hover:text-text-1">
              Huỷ
            </button>
          ) : null}
        </div>
      ) : null}

      {archiveStatus && ['failed', 'cancelled', 'expired'].includes(archiveStatus.status) ? (
        <div className="flex w-full items-center gap-2 rounded-lg border border-warn-border bg-warn-soft px-2.5 py-2 text-[12px] text-warn md:w-auto md:max-w-[300px]">
          <span className="min-w-0 flex-1 truncate" title={archiveStatus.errorMessage || undefined}>
            {archiveStatus.errorMessage || 'Archive chưa hoàn tất.'}
          </span>
          {onRetryDownload ? (
            <button type="button" onClick={onRetryDownload} className="min-h-9 shrink-0 rounded-md bg-surface px-2 font-semibold hover:bg-hover">
              Thử lại
            </button>
          ) : null}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onEditTags}
        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-text-1 font-semibold shadow-xs transition-all hover:bg-surface-2"
      >
        <Tag className="w-3.5 h-3.5" />
        <span>Sửa tag</span>
      </button>

      <button
        type="button"
        onClick={onReport}
        className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-text-1 font-semibold shadow-xs transition-all hover:bg-amber-500/10 hover:border-amber-500/30 hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer"
      >
        <Flag className="w-3.5 h-3.5 text-amber-500" />
        <span>Báo lỗi</span>
      </button>

      <button
        type="button"
        onClick={onClearSelection}
        aria-label="Bỏ chọn tất cả"
        className="grid min-h-11 min-w-11 place-items-center rounded-lg px-2.5 text-text-3 transition-colors hover:bg-hover hover:text-text-1"
        title="Bỏ chọn tất cả"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
