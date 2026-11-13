'use client';

import React from 'react';
import { Keyboard, MousePointer2, PanelsTopLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SelectionMode } from '@/hooks/useBatchSelection';

interface ReviewInspectorProps {
  selectionMode: SelectionMode;
  /** Focus View keeps its established one-photo form visible when nothing is ticked. */
  showCurrentItemWhenEmpty?: boolean;
  renderSingle: () => React.ReactNode;
  renderBatch: () => React.ReactNode;
  className?: string;
}

export function ReviewInspector({
  selectionMode,
  showCurrentItemWhenEmpty = false,
  renderSingle,
  renderBatch,
  className,
}: ReviewInspectorProps) {
  if (selectionMode === 'multi') return <>{renderBatch()}</>;
  if (selectionMode === 'single' || showCurrentItemWhenEmpty) return <>{renderSingle()}</>;

  return (
    <aside className={cn('flex h-full w-full max-w-[420px] flex-col border-l border-border bg-surface p-5 text-text-2', className)} aria-label="Hướng dẫn duyệt ảnh">
      <div className="rounded-2xl border border-border bg-surface-2 p-4">
        <PanelsTopLeft className="h-5 w-5 text-verity" aria-hidden="true" />
        <h2 className="mt-3 text-[15px] font-bold text-text-1">Chọn ảnh để kiểm tra</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed">Mở một ảnh để xem đầy đủ metadata, hoặc tick nhiều ảnh để chuẩn bị duyệt theo lô.</p>
      </div>
      <div className="mt-4 space-y-3 text-[12px]">
        <p className="flex gap-2"><MousePointer2 className="mt-0.5 h-4 w-4 flex-none text-verity" aria-hidden="true" /><span>Click ảnh để vào chế độ Tập trung. Checkbox luôn dùng để chọn ảnh.</span></p>
        <p className="flex gap-2"><Keyboard className="mt-0.5 h-4 w-4 flex-none text-verity" aria-hidden="true" /><span>Trong Grid: Enter mở ảnh, Space chọn ảnh, phím mũi tên chuyển card.</span></p>
      </div>
    </aside>
  );
}
