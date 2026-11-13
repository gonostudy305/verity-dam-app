'use client';

import React, { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface ReviewColumnResizerProps {
  width: number;
  minWidth: number;
  maxWidth: number;
  onChange: (next: number) => void;
  onReset: () => void;
  className?: string;
}

const KEY_STEP = 16;
const KEY_STEP_FAST = 48;

interface DragSession {
  startClientX: number;
  startWidth: number;
}

/**
 * Thanh chia dọc giữa ImagePreviewArea và MetadataForm/BatchReviewForm ở Focus View
 * desktop -- kéo chuột hoặc bàn phím để đổi độ rộng cột Inspector (cột thứ 3).
 * Pattern kéo-thả: rút gọn 2D->1D từ ImageCropperModal.tsx (drag-session ref + window
 * pointermove/pointerup/pointercancel listener).
 */
export function ReviewColumnResizer({
  width,
  minWidth,
  maxWidth,
  onChange,
  onReset,
  className,
}: ReviewColumnResizerProps) {
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragSessionRef = useRef<DragSession | null>(null);

  // Defense-in-depth: nếu component unmount giữa lúc đang kéo (ví dụ breakpoint đổi
  // đột ngột), đảm bảo không để listener treo trên window.
  useEffect(() => {
    return () => {
      dragSessionRef.current = null;
    };
  }, []);

  const clamp = (value: number) => Math.min(maxWidth, Math.max(minWidth, value));

  const handlePointerDown = (event: React.PointerEvent) => {
    event.preventDefault();

    dragSessionRef.current = { startClientX: event.clientX, startWidth: widthRef.current };

    const handleGlobalPointerMove = (moveEvent: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;
      // Inspector là con flex bên phải -- kéo tay cầm sang trái (deltaX âm) phải làm
      // cột rộng ra, nên trừ deltaX chứ không cộng.
      const deltaX = moveEvent.clientX - session.startClientX;
      onChange(clamp(session.startWidth - deltaX));
    };

    const handleGlobalPointerUp = () => {
      dragSessionRef.current = null;
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerUp);
    };

    window.addEventListener('pointermove', handleGlobalPointerMove, { passive: true });
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onChange(clamp(widthRef.current + step));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onChange(clamp(widthRef.current - step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(minWidth);
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(maxWidth);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(width)}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-label="Đổi kích thước khung metadata"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      className={cn(
        'group relative h-full w-2 flex-none cursor-col-resize touch-none select-none',
        'focus:outline-none',
        className
      )}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-verity group-focus-visible:bg-verity" />
    </div>
  );
}
