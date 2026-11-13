'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewQueueItem } from '@/types/media';
import type { SelectionMode } from '@/hooks/useBatchSelection';
import type { BatchGroup } from '@/hooks/useBatchGroups';
import { cn } from '@/lib/utils';
import { ReviewAssetCard } from './ReviewAssetCard';
import { mapBatchGroupsForGrid } from './review-grid-groups';

interface ReviewGridProps {
  items: ReviewQueueItem[];
  currentItemId?: string;
  selectedIds: Set<string>;
  selectionMode: SelectionMode;
  referenceId?: string | null;
  batchGroups?: BatchGroup[];
  loadingMore?: boolean;
  restoreFocusToId?: string | null;
  onOpen: (item: ReviewQueueItem) => void;
  onToggle: (item: ReviewQueueItem) => void;
  onRangeSelect: (item: ReviewQueueItem) => void;
  onSetSelection: (ids: string[], referenceId?: string) => void;
  onSetReference: (item: ReviewQueueItem) => void;
  onReachEnd: () => void;
  className?: string;
}

function columnsForViewport(): number {
  if (typeof window === 'undefined') return 5;
  if (window.innerWidth >= 1536) return 5;
  if (window.innerWidth >= 1280) return 4;
  if (window.innerWidth >= 1024) return 4;
  if (window.innerWidth >= 640) return 3;
  return 2;
}

export function ReviewGrid({
  items,
  currentItemId,
  selectedIds,
  selectionMode,
  referenceId = null,
  batchGroups = [],
  loadingMore = false,
  restoreFocusToId,
  onOpen,
  onToggle,
  onRangeSelect,
  onSetSelection,
  onSetReference,
  onReachEnd,
  className,
}: ReviewGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedId, setFocusedId] = useState<string | null>(currentItemId || items[0]?.id || null);

  useEffect(() => {
    if (focusedId && items.some((item) => item.id === focusedId)) return;
    setFocusedId(currentItemId && items.some((item) => item.id === currentItemId) ? currentItemId : items[0]?.id || null);
  }, [currentItemId, focusedId, items]);

  useEffect(() => {
    if (!restoreFocusToId) return;
    const element = cardRefs.current.get(restoreFocusToId);
    if (!element) return;
    requestAnimationFrame(() => element.focus());
  }, [restoreFocusToId]);

  const focusItemAt = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    setFocusedId(item.id);
    requestAnimationFrame(() => cardRefs.current.get(item.id)?.focus());
  }, [items]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node || node.scrollHeight - node.scrollTop - node.clientHeight > 560) return;
    onReachEnd();
  }, [onReachEnd]);

  const handleCardKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const columns = columnsForViewport();
    let targetIndex: number | null = null;
    if (event.key === 'ArrowLeft') targetIndex = Math.max(0, index - 1);
    if (event.key === 'ArrowRight') targetIndex = Math.min(items.length - 1, index + 1);
    if (event.key === 'ArrowUp') targetIndex = Math.max(0, index - columns);
    if (event.key === 'ArrowDown') targetIndex = Math.min(items.length - 1, index + columns);

    if (targetIndex !== null) {
      event.preventDefault();
      focusItemAt(targetIndex);
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      onToggle(items[index]);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(items[index]);
    }
  }, [focusItemAt, items, onOpen, onToggle]);

  const gridGroups = mapBatchGroupsForGrid(items, batchGroups);
  const queueIndexById = new Map(items.map((item, index) => [item.id, index]));

  const renderCard = (item: ReviewQueueItem, groupLabel?: string, selectedGroupCount = 0) => {
    const index = queueIndexById.get(item.id) ?? 0;
    const isSelected = selectedIds.has(item.id);
    const canMakeReference = selectionMode === 'multi' && isSelected && selectedGroupCount >= 2;
    return (
      <div key={item.id} role="gridcell">
        <ReviewAssetCard
          item={item}
          queuePosition={index}
          isSelected={isSelected}
          isReference={referenceId === item.id}
          canMakeReference={canMakeReference}
          groupLabel={groupLabel}
          selectionMode={selectionMode}
          tabIndex={focusedId === item.id ? 0 : -1}
          cardRef={(node) => {
            if (node) cardRefs.current.set(item.id, node);
            else cardRefs.current.delete(item.id);
          }}
          onOpen={() => onOpen(item)}
          onToggle={(range) => range ? onRangeSelect(item) : onToggle(item)}
          onMakeReference={() => onSetReference(item)}
          onKeyDown={(event) => handleCardKeyDown(event, index)}
        />
      </div>
    );
  };

  return (
    <div ref={scrollRef} onScroll={handleScroll} className={cn('min-h-0 flex-1 overflow-y-auto bg-paper p-3 sm:p-4 lg:p-5', className)}>
      <div role="grid" aria-label="Ảnh đang chờ duyệt" className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5">
        {gridGroups.map((group) => {
          const groupSelectedCount = group.itemIds.filter((id) => selectedIds.has(id)).length;
          const isAllSelected = group.itemIds.length > 0 && groupSelectedCount === group.itemIds.length;
          const groupItems = group.itemIds.map((id) => items.find((item) => item.id === id)).filter((item): item is ReviewQueueItem => Boolean(item));
          return (
            <React.Fragment key={group.key}>
              {group.isVisualGroup ? (
                <div className="col-span-full flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3">
                  <div className="min-w-0">
                    <p className="truncate text-[12px] font-bold text-text-1">{group.label}</p>
                    <p className="text-[10.5px] text-text-3">{group.itemIds.length} ảnh trong lô</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const nextIds = isAllSelected
                        ? Array.from(selectedIds).filter((id) => !group.itemIds.includes(id))
                        : group.itemIds;
                      const nextReferenceId = referenceId && nextIds.includes(referenceId) ? referenceId : undefined;
                      onSetSelection(nextIds, nextReferenceId);
                    }}
                    className={cn(
                      'min-h-11 flex-none rounded-lg border px-3 text-[11.5px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
                      isAllSelected ? 'border-verity bg-verity text-white' : 'border-border bg-surface text-text-2 hover:border-verity hover:text-verity'
                    )}
                  >
                    {isAllSelected ? 'Bỏ chọn lô' : 'Chọn lô'}
                  </button>
                </div>
              ) : null}
              {groupItems.map((item) => renderCard(item, group.isVisualGroup ? group.label : undefined, groupSelectedCount))}
            </React.Fragment>
          );
        })}
      </div>
      <div className="grid min-h-16 place-items-center text-[12px] text-text-3" aria-live="polite">
        {loadingMore ? 'Đang tải thêm ảnh…' : 'Cuộn để tải thêm ảnh đang chờ duyệt'}
      </div>
    </div>
  );
}
