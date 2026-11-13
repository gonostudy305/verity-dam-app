'use client';

import React, { useEffect, useRef } from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/utils';

interface UploadDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  className?: string;
  /** Smaller "add more to this batch" affordance shown once a batch is already staged. */
  compact?: boolean;
  title?: string;
  subtitle?: string;
}

export function UploadDropzone({
  onFilesSelected,
  className,
  compact = false,
  title = 'Kéo thả 1–100 ảnh hoặc video vào đây',
  subtitle = 'hoặc dán trực tiếp từ Zalo',
}: UploadDropzoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
    }
    // Reset so picking the exact same file again (e.g. after removing it
    // from the staged batch) still fires onChange.
    e.target.value = '';
  };

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        event.preventDefault();
        onFilesSelected(files);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [onFilesSelected]);

  const openPicker = () => fileInputRef.current?.click();

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={openPicker}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPicker();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={title}
      className={cn(
        'group flex cursor-pointer flex-col items-center justify-center gap-3.5 rounded-2xl border-2 border-dashed border-border-strong bg-surface p-6 text-center shadow-xs transition-all select-none hover:border-verity hover:bg-surface-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-offset-2',
        compact ? 'h-[110px]' : 'h-[300px]',
        className
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {!compact && (
        <div className="w-14 h-14 rounded-2xl bg-verity-soft text-verity-fg grid place-items-center group-hover:scale-110 transition-transform shadow-xs">
          <UploadCloud className="w-7 h-7" />
        </div>
      )}

      <div className="space-y-1">
        <h3 className={cn('font-bold text-text-1', compact ? 'text-[13px]' : 'text-[17px]')}>
          {title}
        </h3>
        <p className="text-[13px] text-text-2 flex items-center justify-center gap-1.5">
          <span>{subtitle}</span>
          <kbd className="font-mono text-[11px] font-bold px-2 py-0.5 rounded bg-surface-2 border border-border text-text-1">
            Ctrl V
          </kbd>
        </p>
      </div>

      {!compact && (
        <span className="mt-2 inline-flex min-h-11 items-center rounded-xl bg-verity px-5 text-[13px] font-bold text-white shadow-sm transition-all group-hover:bg-verity-hover">
          Chọn ảnh từ máy
        </span>
      )}
    </div>
  );
}
