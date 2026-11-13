'use client';

import React from 'react';
import Link from 'next/link';
import { UploadItem } from '@/types/media';
import { Check, Loader2, AlertTriangle, FileImage, ArrowUpRight, Eye, HelpCircle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PipelineCardListProps {
  items: UploadItem[];
  onKeepDupe: (id: string) => void;
  onDropDupe: (id: string) => void;
  onRecheckStatus?: (taskId: string, assetId: string) => void;
  recheckingIds?: Set<string>;
  className?: string;
}

export function PipelineCardList({
  items,
  onKeepDupe,
  onDropDupe,
  onRecheckStatus,
  recheckingIds,
  className,
}: PipelineCardListProps) {
  const stageLabels = [
    { label: 'Đang tải lên', color: 'text-text-3' },
    { label: 'Xác minh tệp', color: 'text-verity' },
    { label: 'Khởi tạo phân tích AI', color: 'text-ai' },
    { label: 'Đã nhận tệp · Chờ phân tích', color: 'text-ok' },
  ];

  return (
    <div
      className={cn(
        'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5',
        className
      )}
    >
      {items.map((item) => {
        const workerLabel = item.processing_state === 'queued'
          ? { label: 'Đang xếp hàng phân tích', color: 'text-ai' }
          : item.processing_state === 'processing'
            ? { label: 'Đang phân tích', color: 'text-ai' }
            : item.processing_state === 'ready'
              ? { label: 'Sẵn sàng duyệt', color: 'text-ok' }
              : item.processing_state === 'blocked'
                ? { label: 'Bị chặn · cần kiểm tra', color: 'text-bad' }
                : item.processing_state === 'unknown'
                  ? { label: 'Không rõ trạng thái', color: 'text-warn' }
                  : null;
        const stageInfo = workerLabel || stageLabels[Math.min(item.stage, 3)];
        const isDone = item.stage >= 3 && item.processing_state === 'ready';
        const needsRecheck = item.processing_state === 'blocked' || item.processing_state === 'unknown';
        const hasError = Boolean(item.error);
        const hasAsset = Boolean(item.assetId || item.reviewQueueId);
        const reviewUrl = item.assetId
          ? `/review?assetId=${encodeURIComponent(item.assetId)}`
          : item.reviewQueueId
            ? `/review?queueId=${encodeURIComponent(item.reviewQueueId)}`
            : '/review';

        return (
          <div
            key={item.id}
            className={cn(
              'group relative flex flex-col rounded-xl overflow-hidden border bg-surface shadow-xs transition-all duration-200',
              item.is_duplicate
                ? 'border-gold-border ring-1 ring-gold/40'
                : isDone
                  ? 'border-border hover:border-verity/60 hover:shadow-md'
                  : 'border-border'
            )}
          >
            {/* Image Preview / Dupe comparison */}
            {hasAsset ? (
              <Link
                href={reviewUrl}
                title="Click để mở đúng ảnh này trong hàng chờ duyệt"
                className="flex h-[120px] bg-surface-2 overflow-hidden relative items-center justify-center cursor-pointer block"
              >
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt="Upload preview"
                    className="flex-1 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5 text-text-3">
                    <FileImage className="w-8 h-8 opacity-60" />
                    <span className="text-[10.5px] font-medium">Đang xử lý ảnh…</span>
                  </div>
                )}
                {item.is_duplicate && item.duplicate_preview && (
                  <div className="flex-1 border-l-2 border-gold relative overflow-hidden h-full">
                    <img
                      src={item.duplicate_preview}
                      alt="Existing dupe"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white font-mono text-[9px]">
                      Ảnh cũ
                    </span>
                  </div>
                )}

                {/* Hover overlay hint */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-1.5 text-white text-[12px] font-medium backdrop-blur-[1px]">
                  <Eye className="w-4 h-4" />
                  <span>Duyệt ảnh này</span>
                </div>
              </Link>
            ) : (
              <div className="flex h-[120px] bg-surface-2 overflow-hidden relative items-center justify-center">
                {item.previewUrl ? (
                  <img
                    src={item.previewUrl}
                    alt="Upload preview"
                    className="flex-1 w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center gap-1.5 text-text-3">
                    <FileImage className="w-8 h-8 opacity-60" />
                    <span className="text-[10.5px] font-medium">Đang xử lý ảnh…</span>
                  </div>
                )}
                {item.is_duplicate && item.duplicate_preview && (
                  <div className="flex-1 border-l-2 border-gold relative overflow-hidden h-full">
                    <img
                      src={item.duplicate_preview}
                      alt="Existing dupe"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/60 text-white font-mono text-[9px]">
                      Ảnh cũ
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Status & Progress Bar */}
            <div className="p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="font-mono text-text-2 truncate max-w-[120px]" title={'name' in item.file ? item.file.name : 'upload.jpg'}>
                  {'name' in item.file ? item.file.name : 'upload.jpg'}
                </span>

                {isDone && hasAsset ? (
                  <Link
                    href={reviewUrl}
                    className="font-semibold flex items-center gap-1 text-ok hover:underline"
                    title="Click để duyệt ảnh này"
                  >
                    <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Sẵn sàng duyệt</span>
                    <ArrowUpRight className="w-3 h-3 opacity-80" />
                  </Link>
                ) : (
                  <span className={cn('font-semibold flex items-center gap-1', stageInfo.color)}>
                    {hasError ? (
                      <AlertTriangle className="w-3.5 h-3.5 stroke-[2.5]" />
                    ) : item.processing_state === 'blocked' ? (
                      <AlertTriangle className="w-3.5 h-3.5 stroke-[2.5]" />
                    ) : item.processing_state === 'unknown' ? (
                      <HelpCircle className="w-3.5 h-3.5 stroke-[2.5]" />
                    ) : (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    )}
                    <span>{hasError ? 'Upload lỗi' : stageInfo.label}</span>
                  </span>
                )}
              </div>

              {/* Progress Line */}
              <div
                role="progressbar"
                aria-label={`Tiến độ xử lý ${'name' in item.file ? item.file.name : 'tệp upload'}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={isDone || needsRecheck ? 100 : item.progress}
                className="h-1 w-full overflow-hidden rounded-full bg-surface-inset"
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    hasError || item.processing_state === 'blocked' ? 'bg-bad' : item.processing_state === 'unknown' ? 'bg-warn' : isDone ? 'bg-ok' : 'bg-verity'
                  )}
                  style={{ width: `${isDone || needsRecheck ? 100 : item.progress}%` }}
                />
              </div>

              {hasError && <p className="text-[11px] leading-snug text-bad">{item.error}</p>}

              {!hasError && item.job_issue && (
                <p role="status" className="text-[11px] leading-snug text-warn" data-testid="upload-job-issue">
                  {item.job_issue}
                </p>
              )}

              {needsRecheck && item.assetId && onRecheckStatus && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRecheckStatus(item.id, item.assetId as string);
                  }}
                  disabled={recheckingIds?.has(item.id)}
                  className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border bg-surface text-[11px] font-semibold text-text-2 transition-all hover:bg-surface-2 hover:text-text-1 disabled:opacity-60"
                >
                  <RefreshCw className={cn('w-3 h-3', recheckingIds?.has(item.id) && 'animate-spin')} />
                  <span>Kiểm tra lại trạng thái</span>
                </button>
              )}

              {/* Duplicate Inline Choice */}
              {item.is_duplicate && !isDone && (
                <div className="flex items-center justify-between pt-1 border-t border-border-subtle mt-0.5 text-[11.5px]">
                  <span className="font-bold text-warn flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    <span>Trùng {item.duplicate_pct || 94}%</span>
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onKeepDupe(item.id);
                      }}
                      className="min-h-11 rounded border border-border bg-surface px-3 text-text-1 font-bold transition-colors hover:bg-surface-2"
                    >
                      Giữ
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDropDupe(item.id);
                      }}
                      className="min-h-11 rounded border border-border bg-surface px-3 text-text-1 font-bold transition-colors hover:bg-surface-2"
                    >
                      Bỏ
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
