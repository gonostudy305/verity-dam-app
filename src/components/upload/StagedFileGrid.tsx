'use client';

import { useState, useEffect, useCallback } from 'react';
import { X, Image as ImageIcon, Video, Play, ChevronLeft, ChevronRight, ZoomIn, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Ảnh import từ URL không có đối tượng `File` (bytes nằm sẵn trên R2), nên
 * chỗ này chỉ cần phần metadata mà thẻ xem trước thực sự đọc. */
export interface StagedFileMeta {
  name: string;
  size: number;
  type: string;
}

export interface StagedFile {
  id: string;
  file: File | StagedFileMeta;
  previewUrl: string;
}

interface StagedFileGridProps {
  files: StagedFile[];
  onRemove: (id: string) => void;
  className?: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StagedItemCard({
  staged,
  index,
  onRemove,
  onPreview,
}: {
  staged: StagedFile;
  index: number;
  onRemove: (id: string) => void;
  onPreview: (index: number) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const isVideo = staged.file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(staged.file.name);
  const isHeic = /\.(heic|heif)$/i.test(staged.file.name) || staged.file.type === 'image/heic' || staged.file.type === 'image/heif';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onPreview(index)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(index);
        }
      }}
      className="group relative flex flex-col rounded-xl overflow-hidden border border-border bg-surface shadow-2xs hover:border-verity/60 hover:shadow-md hover:ring-2 hover:ring-verity/20 transition-all cursor-pointer text-left"
    >
      {/* Media Preview */}
      <div className="h-[110px] bg-surface-2 overflow-hidden relative flex items-center justify-center select-none">
        {isVideo ? (
          <div className="relative w-full h-full bg-black/60 flex items-center justify-center">
            <video
              src={staged.previewUrl}
              className="w-full h-full object-cover opacity-75"
              muted
              playsInline
              preload="metadata"
            />
            <div className="absolute w-8 h-8 rounded-full bg-black/70 text-white grid place-items-center shadow-xs">
              <Play className="w-4 h-4 ml-0.5 fill-white" />
            </div>
            <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-blue-600/90 text-[9px] font-bold tracking-wider text-white uppercase flex items-center gap-1 shadow-xs">
              <Video className="w-2.5 h-2.5" />
              VIDEO
            </span>
          </div>
        ) : isHeic && imgFailed ? (
          <div className="flex flex-col items-center justify-center gap-1 text-text-3 p-2 text-center">
            <ImageIcon className="w-7 h-7 text-text-3/60" />
            <span className="text-[10px] font-medium text-text-2">Ảnh HEIC iPhone</span>
            <span className="text-[9px] text-text-3">Sẽ chuyển đổi khi tải</span>
          </div>
        ) : (
          <>
            <img
              src={staged.previewUrl}
              alt={staged.file.name}
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
            />
            {isHeic && (
              <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-amber-600/90 text-[9px] font-bold tracking-wider text-white uppercase shadow-xs">
                HEIC
              </span>
            )}
          </>
        )}

        {/* Hover zoom overlay */}
        <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
          <div className="rounded-full bg-black/60 p-1.5 text-white shadow-xs">
            <ZoomIn className="w-4 h-4" />
          </div>
        </div>

        <span className="absolute bottom-1 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-mono text-white font-medium">
          #{index + 1}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(staged.id);
          }}
          title="Bỏ tệp này khỏi lô"
          className="absolute right-1.5 top-1.5 z-10 grid min-h-11 min-w-11 place-items-center rounded-full bg-black/70 text-white opacity-100 shadow-xs transition-all hover:bg-bad focus:outline-none focus-visible:ring-2 focus-visible:ring-white sm:min-h-0 sm:min-w-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Info Row */}
      <div className="px-2.5 py-1.5 border-t border-border-subtle bg-surface">
        <p className="text-[11px] font-medium text-text-1 truncate" title={staged.file.name}>
          {staged.file.name}
        </p>
        <p className="text-[10px] font-mono text-text-3">{formatSize(staged.file.size)}</p>
      </div>
    </div>
  );
}

export function StagedFileGrid({ files, onRemove, className }: StagedFileGridProps) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const activeFile = previewIndex !== null && previewIndex >= 0 && previewIndex < files.length ? files[previewIndex] : null;

  const handleClose = useCallback(() => {
    setPreviewIndex(null);
  }, []);

  const handlePrev = useCallback(() => {
    setPreviewIndex((current) => {
      if (current === null || files.length === 0) return null;
      return current > 0 ? current - 1 : files.length - 1;
    });
  }, [files.length]);

  const handleNext = useCallback(() => {
    setPreviewIndex((current) => {
      if (current === null || files.length === 0) return null;
      return current < files.length - 1 ? current + 1 : 0;
    });
  }, [files.length]);

  const handleRemoveActive = useCallback(() => {
    if (!activeFile) return;
    const removingId = activeFile.id;
    onRemove(removingId);
    if (files.length <= 1) {
      setPreviewIndex(null);
    } else if (previewIndex !== null && previewIndex >= files.length - 1) {
      setPreviewIndex(Math.max(0, files.length - 2));
    }
  }, [activeFile, files.length, onRemove, previewIndex]);

  useEffect(() => {
    if (previewIndex === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        handleRemoveActive();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewIndex, handleClose, handlePrev, handleNext, handleRemoveActive]);

  const isVideo = activeFile ? (activeFile.file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(activeFile.file.name)) : false;

  return (
    <div className={cn('space-y-2', className)}>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {files.map((staged, index) => (
          <StagedItemCard
            key={staged.id}
            staged={staged}
            index={index}
            onRemove={onRemove}
            onPreview={(idx) => setPreviewIndex(idx)}
          />
        ))}
      </div>

      {activeFile && previewIndex !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Xem chi tiết ${activeFile.file.name}`}
          className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-xs select-none animate-in fade-in duration-150"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleClose();
          }}
        >
          {/* Top Header */}
          <div className="flex h-14 flex-none items-center justify-between border-b border-white/10 px-4 text-white">
            <div className="flex items-center gap-3 min-w-0">
              <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-white/90">
                {previewIndex + 1} / {files.length}
              </span>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white/95" title={activeFile.file.name}>
                  {activeFile.file.name}
                </p>
                <p className="text-[11px] font-mono text-white/60">
                  {formatSize(activeFile.file.size)}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRemoveActive}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/20 px-3 py-1.5 text-[12px] font-semibold text-red-300 transition-colors hover:bg-red-500/30 hover:text-white"
                title="Bỏ tệp này khỏi danh sách (phím Delete)"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Bỏ tệp</span>
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
                title="Đóng (Esc)"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Main Content Area */}
          <div className="relative flex flex-1 items-center justify-center p-4">
            {files.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={handlePrev}
                  className="absolute left-3 z-10 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur-xs transition-all hover:bg-black/90 hover:text-white hover:scale-105"
                  title="Ảnh trước (←)"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  type="button"
                  onClick={handleNext}
                  className="absolute right-3 z-10 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur-xs transition-all hover:bg-black/90 hover:text-white hover:scale-105"
                  title="Ảnh tiếp theo (→)"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}

            <div className="flex h-full max-h-[78vh] w-full max-w-[90vw] items-center justify-center">
              {isVideo ? (
                <video
                  src={activeFile.previewUrl}
                  controls
                  autoPlay
                  playsInline
                  className="max-h-full max-w-full rounded-xl object-contain shadow-2xl"
                />
              ) : (
                <img
                  src={activeFile.previewUrl}
                  alt={activeFile.file.name}
                  className="max-h-full max-w-full rounded-xl object-contain shadow-2xl transition-all"
                />
              )}
            </div>
          </div>

          {/* Bottom Hint */}
          <div className="flex h-10 flex-none items-center justify-center border-t border-white/10 px-4 text-[11.5px] text-white/50">
            Dùng phím <kbd className="mx-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/80">←</kbd> / <kbd className="mx-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/80">→</kbd> để duyệt · <kbd className="mx-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/80">Delete</kbd> để bỏ tệp · <kbd className="mx-1 rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/80">Esc</kbd> để đóng
          </div>
        </div>
      )}
    </div>
  );
}

