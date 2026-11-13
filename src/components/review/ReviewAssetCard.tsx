'use client';

import React from 'react';
import { Check, Copy, Eye, LockKeyhole, Star, TriangleAlert, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReviewQueueItem } from '@/types/media';
import type { SelectionMode } from '@/hooks/useBatchSelection';
import { getReviewCardSignals } from './review-card-signals';

export interface ReviewAssetCardProps {
  item: ReviewQueueItem;
  queuePosition: number;
  isSelected: boolean;
  isReference?: boolean;
  canMakeReference?: boolean;
  groupLabel?: string;
  selectionMode: SelectionMode;
  tabIndex: number;
  cardRef?: (node: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onToggle: (range?: boolean) => void;
  onMakeReference?: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

/** A decision-oriented Grid card: metadata is intentionally brief; deep edit stays in Focus View. */
export function ReviewAssetCard({
  item,
  queuePosition,
  isSelected,
  isReference = false,
  canMakeReference = false,
  groupLabel,
  selectionMode,
  tabIndex,
  cardRef,
  onOpen,
  onToggle,
  onMakeReference,
  onKeyDown,
}: ReviewAssetCardProps) {
  const { asset } = item;
  const signals = getReviewCardSignals(item);
  const modelName = item.sku_match?.catalog_identity?.model_name
    || item.sku_match?.catalog_identity?.display_name;
  const label = asset.title || asset.sku || `Ảnh chờ duyệt ${queuePosition + 1}`;

  const handleCardClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey) {
      onToggle(true);
      return;
    }
    if (selectionMode === 'none') onOpen();
    else onToggle();
  };

  return (
    <article
      className={cn(
        'overflow-hidden rounded-xl border bg-surface shadow-xs transition-colors',
        isSelected ? 'border-verity ring-2 ring-verity/20' : 'border-border hover:border-verity/45',
        groupLabel && 'border-l-[3px] border-l-verity/45'
      )}
      data-review-card-id={item.id}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border/80 bg-surface-2 px-1.5">
        <button
          type="button"
          onClick={(event) => onToggle(event.shiftKey)}
          aria-label={isSelected ? `Bỏ chọn ${label}` : `Chọn ${label}`}
          aria-pressed={isSelected}
          className={cn(
            'inline-grid h-11 w-11 flex-none place-items-center rounded-lg text-text-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
            isSelected ? 'bg-verity text-white' : 'hover:bg-hover hover:text-text-1'
          )}
        >
          <span className={cn(
            'grid h-5 w-5 place-items-center rounded border',
            isSelected ? 'border-white/70 bg-white/15' : 'border-border bg-surface'
          )}>
            {isSelected ? <Check className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" /> : null}
          </span>
        </button>
        {canMakeReference ? (
          <button
            type="button"
            onClick={onMakeReference}
            aria-label={isReference ? `Ảnh Reference của ${groupLabel || 'lô'}` : `Đặt ${label} làm ảnh Reference`}
            aria-pressed={isReference}
            className={cn(
              'inline-grid h-11 w-11 flex-none place-items-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
              isReference ? 'bg-amber-500 text-white' : 'text-text-3 hover:bg-amber-500/10 hover:text-amber-600'
            )}
            title={isReference ? 'Ảnh Reference đang chọn' : 'Đặt làm ảnh Reference cho lô'}
          >
            <Star className={cn('h-4 w-4', isReference && 'fill-current')} aria-hidden="true" />
          </button>
        ) : null}
        <div className="pointer-events-none flex min-w-0 items-center justify-end gap-1.5 pr-1 text-[10px] font-semibold">
          {signals.isInternal ? <span className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-1 text-warn"><LockKeyhole className="h-3 w-3" aria-hidden="true" />Chỉ nội bộ</span> : null}
          {signals.isDuplicate ? <span className="inline-flex items-center gap-1 rounded-md bg-bad-soft px-1.5 py-1 text-bad"><Copy className="h-3 w-3" aria-hidden="true" />Trùng</span> : null}
          {signals.needsPostProduction ? <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-1.5 py-0.5"><Wrench className="h-2.5 w-2.5" aria-hidden="true" />Hậu kỳ</span> : null}
          <span className="font-mono text-text-3">#{queuePosition + 1}</span>
        </div>
      </div>

      <button
        ref={cardRef}
        type="button"
        tabIndex={tabIndex}
        onClick={handleCardClick}
        onKeyDown={onKeyDown}
        aria-label={selectionMode === 'none' ? `Mở kiểm tra ${label}` : `Chọn hoặc bỏ chọn ${label}`}
        aria-pressed={isSelected}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-verity"
      >
        <div className="aspect-square bg-surface-2 p-2">
          {asset.thumbnail_url ? (
            <img src={asset.thumbnail_url} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full w-full place-items-center text-text-3"><Eye className="h-6 w-6" aria-hidden="true" /></div>
          )}
        </div>
        <div className="space-y-1.5 border-t border-border/80 p-2.5">
          <p className="truncate text-[12px] font-bold text-text-1" title={label}>{label}</p>
          <p className={cn('truncate font-mono text-[11px] font-semibold', signals.hasMissingSku ? 'text-warn' : 'text-text-2')}>
            {signals.hasMissingSku ? 'Thiếu SKU' : asset.sku}
          </p>
          {modelName ? <p className="truncate text-[10.5px] text-text-3" title={modelName}>{modelName}</p> : null}
          <div className="flex flex-wrap gap-1">
            {signals.hasLowConfidence ? <span className="inline-flex items-center gap-1 rounded-md bg-warn-soft px-1.5 py-1 text-[10px] font-bold text-warn"><TriangleAlert className="h-3 w-3" aria-hidden="true" />{signals.confidence}%</span> : null}
            {signals.hasPeople ? <span className="rounded-md bg-warn-soft px-1.5 py-1 text-[10px] font-bold text-warn">Có người</span> : null}
            {!signals.hasLowConfidence && signals.confidence !== null ? <span className="rounded-md bg-ok-soft px-1.5 py-1 font-mono text-[10px] font-bold text-ok">{signals.confidence}%</span> : null}
          </div>
        </div>
      </button>
    </article>
  );
}
