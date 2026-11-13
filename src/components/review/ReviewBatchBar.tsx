'use client';

import React from 'react';
import { Check, Clock3, ListChecks, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SelectionMode } from '@/hooks/useBatchSelection';

interface ReviewBatchBarProps {
  selectionMode: SelectionMode;
  selectedCount: number;
  loadedCount: number;
  isSubmitting?: boolean;
  onClear: () => void;
  onSelectAll: () => void;
  onSkip: () => void;
  onReject: () => void;
  onReview: () => void;
  className?: string;
}

export function ReviewBatchBar({
  selectionMode,
  selectedCount,
  loadedCount,
  isSubmitting = false,
  onClear,
  onSelectAll,
  onSkip,
  onReject,
  onReview,
  className,
}: ReviewBatchBarProps) {
  if (selectionMode === 'none') return null;

  return (
    <div className={cn('flex flex-none flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-[0_-6px_18px_rgba(15,23,42,0.05)] sm:px-5', className)} aria-label="Thao tác ảnh đã chọn" role="toolbar">
      <p className="mr-auto text-[12.5px] font-bold text-text-1">Đã chọn {selectedCount} ảnh</p>
      <button type="button" onClick={onClear} disabled={isSubmitting} className="min-h-11 rounded-lg px-3 text-[11.5px] font-bold text-text-2 hover:bg-hover disabled:opacity-50">Bỏ chọn</button>
      <button type="button" onClick={onSelectAll} disabled={isSubmitting} className="min-h-11 rounded-lg border border-border px-3 text-[11.5px] font-bold text-text-2 hover:border-verity hover:text-verity disabled:opacity-50">Chọn {loadedCount} ảnh đã tải</button>
      <button type="button" onClick={onSkip} disabled={isSubmitting} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-[11.5px] font-bold text-text-2 hover:bg-hover disabled:opacity-50"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />Để sau</button>
      <button type="button" onClick={onReject} disabled={isSubmitting} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-warn-border px-3 text-[11.5px] font-bold text-warn hover:bg-warn-soft disabled:opacity-50"><X className="h-3.5 w-3.5" aria-hidden="true" />Từ chối</button>
      <button type="button" aria-label="Kiểm tra & duyệt" title="Kiểm tra & duyệt" onClick={onReview} disabled={isSubmitting} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-verity px-3 text-[11.5px] font-bold text-white shadow-sm hover:bg-verity-hover disabled:opacity-50"><Check className="h-3.5 w-3.5" aria-hidden="true" /><span className="hidden sm:inline">Kiểm tra &amp; duyệt</span><ListChecks className="h-3.5 w-3.5 sm:hidden" aria-hidden="true" /></button>
    </div>
  );
}
