'use client';

import React from 'react';
import { Focus, Grid3X3 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ReviewViewMode = 'grid' | 'focus';

interface ReviewToolbarProps {
  viewMode: ReviewViewMode;
  currentIndex: number;
  totalCount: number;
  onViewModeChange: (mode: ReviewViewMode) => void;
}

export function ReviewToolbar({ viewMode, currentIndex, totalCount, onViewModeChange }: ReviewToolbarProps) {
  const contextLabel = viewMode === 'focus' ? (
    <>
      <span className="hidden sm:inline">Ảnh </span>
      <span className="font-mono font-semibold text-text-2">{currentIndex + 1}</span>
      {' / '}
      <span className="font-mono">{totalCount}</span>
    </>
  ) : (
    <>
      <span className="font-mono font-semibold text-text-2">{totalCount}</span>
      <span className="hidden sm:inline"> ảnh cần duyệt</span>
    </>
  );

  return (
    <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
      <p className="text-[11px] font-medium text-text-3 shrink-0 whitespace-nowrap" aria-live="polite">
        {contextLabel}
      </p>
      <div
        role="tablist"
        aria-label="Chế độ xem hàng chờ duyệt"
        className="flex h-8 min-h-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 shrink-0 select-none border border-border/40"
      >
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'focus'}
          onClick={() => onViewModeChange('focus')}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 min-h-0 px-2 sm:px-2.5 rounded-md text-[11.5px] font-semibold whitespace-nowrap transition-all cursor-pointer shrink-0',
            viewMode === 'focus'
              ? 'bg-surface text-verity shadow-xs font-bold'
              : 'text-text-2 hover:bg-surface/60 hover:text-text-1'
          )}
          title="Chế độ Tập trung (xem từng ảnh chi tiết)"
        >
          <Focus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">Tập trung</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'grid'}
          onClick={() => onViewModeChange('grid')}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 min-h-0 px-2 sm:px-2.5 rounded-md text-[11.5px] font-semibold whitespace-nowrap transition-all cursor-pointer shrink-0',
            viewMode === 'grid'
              ? 'bg-surface text-verity shadow-xs font-bold'
              : 'text-text-2 hover:bg-surface/60 hover:text-text-1'
          )}
          title="Chế độ Tổng quan (lưới thumbnail)"
        >
          <Grid3X3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">Tổng quan</span>
        </button>
      </div>
    </div>
  );
}
