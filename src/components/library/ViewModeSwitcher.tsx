'use client';

import React from 'react';
import { Columns3, Rows3 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ViewMode = 'justified' | 'masonry';

interface ViewModeSwitcherProps {
  viewMode: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

export function ViewModeSwitcher({ viewMode, onChange, className }: ViewModeSwitcherProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xl border border-border bg-surface-2/80 p-0.5',
        className
      )}
    >
      <button
        type="button"
        onClick={() => onChange('justified')}
        title="Dạng hàng căn đều (Google Photos - đọc từ trái qua phải)"
        aria-label="Xem dạng hàng căn đều"
        aria-pressed={viewMode === 'justified'}
        className={cn(
          'p-1.5 rounded-lg transition-all flex items-center gap-1 text-[11.5px] font-semibold',
          viewMode === 'justified'
            ? 'bg-surface text-text-1 border border-border shadow-xs'
            : 'text-text-3 hover:text-text-1 border border-transparent'
        )}
      >
        <Rows3 className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Hàng</span>
      </button>

      <button
        type="button"
        onClick={() => onChange('masonry')}
        title="Dạng cột Pinterest (Masonry)"
        aria-label="Xem dạng cột Masonry"
        aria-pressed={viewMode === 'masonry'}
        className={cn(
          'p-1.5 rounded-lg transition-all flex items-center gap-1 text-[11.5px] font-semibold',
          viewMode === 'masonry'
            ? 'bg-surface text-text-1 border border-border shadow-xs'
            : 'text-text-3 hover:text-text-1 border border-transparent'
        )}
      >
        <Columns3 className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Cột</span>
      </button>
    </div>
  );
}
