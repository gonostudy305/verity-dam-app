import React, { useEffect, useRef } from 'react';
import { MediaAsset } from '@/types/media';
import { cn } from '@/lib/utils';
import { Check, Star, FolderOpen } from 'lucide-react';
import type { BatchGroup } from '@/hooks/useBatchGroups';
import type { SelectionMode } from '@/hooks/useBatchSelection';

export interface FilmstripProps {
  items: { id: string; asset: MediaAsset }[];
  currentIndex: number;
  onSelect: (index: number) => void;
  batchGroups?: BatchGroup[];
  selectedIds?: Set<string>;
  referenceId?: string | null;
  selectionMode?: SelectionMode;
  onBatchSelect?: (ids: string[]) => void;
  onToggleSelect?: (id: string) => void;
  onRangeSelect?: (id: string) => void;
  onSetReference?: (id: string) => void;
  className?: string;
}

export function Filmstrip({
  items,
  currentIndex,
  onSelect,
  batchGroups,
  selectedIds = new Set(),
  referenceId = null,
  selectionMode = 'none',
  onBatchSelect,
  onToggleSelect,
  onRangeSelect,
  onSetReference,
  className,
}: FilmstripProps) {
  const activeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);
  const hasDraggedRef = useRef(false);

  // Auto scroll active thumbnail into view
  useEffect(() => {
    if (activeRef.current && !isDraggingRef.current) {
      activeRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [currentIndex]);

  // Smart horizontal wheel scroll: convert vertical mousewheel into horizontal pan
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      // If user is already scrolling horizontally (trackpad with deltaX), respect default
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // Only primary left click initiates drag
    const el = containerRef.current;
    if (!el) return;

    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    startXRef.current = e.pageX - el.offsetLeft;
    scrollLeftRef.current = el.scrollLeft;
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    const el = containerRef.current;
    if (!el) return;

    const x = e.pageX - el.offsetLeft;
    const walk = (x - startXRef.current) * 1.4;
    if (Math.abs(walk) > 4) {
      hasDraggedRef.current = true;
    }
    el.scrollLeft = scrollLeftRef.current - walk;
  };

  const handleMouseUpOrLeave = () => {
    isDraggingRef.current = false;
    setTimeout(() => {
      hasDraggedRef.current = false;
    }, 60);
  };

  if (!items || items.length <= 1) return null;

  const handleClick = (e: React.MouseEvent, idx: number) => {
    // If user dragged the filmstrip, do not trigger thumbnail selection
    if (hasDraggedRef.current) {
      e.preventDefault();
      return;
    }
    const id = items[idx]?.id;
    if (!id) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      onToggleSelect?.(id);
      onSelect(idx);
    } else if (e.shiftKey) {
      e.preventDefault();
      onRangeSelect?.(id);
      onSelect(idx);
    } else {
      onSelect(idx);
    }
  };

  const renderThumbnail = (item: { id: string; asset: MediaAsset }, idx: number) => {
    const isActive = idx === currentIndex;
    const isSelected = selectedIds.has(item.id);
    const isReference = referenceId === item.id;

    return (
      <button
        key={item.id}
        ref={isActive ? activeRef : null}
        type="button"
        onClick={(e) => handleClick(e, idx)}
        className={cn(
          'group relative flex-none w-[72px] h-[54px] rounded-lg overflow-hidden border-2 transition-all select-none',
          isSelected
            ? 'border-verity ring-2 ring-verity/30 opacity-100 scale-[1.02]'
            : isActive
              ? 'border-verity/80 ring-2 ring-verity/20 opacity-100 scale-[1.01]'
              : 'border-border/60 hover:border-border opacity-60 hover:opacity-90'
        )}
        title={
          selectionMode === 'multi'
            ? `${item.asset.title || 'Ảnh'}\n• Ctrl+Click: Chọn/bỏ chọn\n• Shift+Click: Chọn dải`
            : item.asset.title
        }
      >
        <img
          src={item.asset.thumbnail_url}
          alt={item.asset.title || 'Thumbnail'}
          className="w-full h-full object-cover"
        />

        {/* Multi-select checkbox overlay */}
        <div
          role="button"
          tabIndex={0}
          onMouseDown={(e) => {
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect?.(item.id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onToggleSelect?.(item.id);
            }
          }}
          aria-label={isSelected ? `Bỏ chọn ảnh ${idx + 1}` : `Chọn ảnh ${idx + 1}`}
          className={cn(
            'absolute top-1 left-1 w-5 h-5 rounded-md flex items-center justify-center transition-all z-10',
            isSelected
              ? 'bg-verity text-white shadow-xs opacity-100 ring-1 ring-white/40'
              : 'bg-black/60 text-transparent hover:bg-black/80 hover:text-white/80 opacity-0 group-hover:opacity-100'
          )}
          title={isSelected ? 'Bỏ chọn ảnh này' : 'Chọn ảnh này'}
        >
          <Check className={cn('w-3.5 h-3.5', isSelected ? 'stroke-[3]' : 'opacity-80')} />
        </div>

        {/* Reference Star indicator */}
        {isSelected && (
          <div
            role="button"
            tabIndex={0}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSetReference?.(item.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                onSetReference?.(item.id);
              }
            }}
            aria-label={isReference ? `Ảnh đại diện mẫu ${idx + 1}` : `Đặt ảnh ${idx + 1} làm ảnh đại diện`}
            className={cn(
              'absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center transition-all z-10',
              isReference
                ? 'bg-amber-500 text-white shadow-xs opacity-100 ring-1 ring-white/50'
                : 'bg-black/50 text-white/70 hover:bg-amber-500 hover:text-white opacity-0 group-hover:opacity-100'
            )}
            title={isReference ? 'Ảnh đại diện Reference (nạp vector chuẩn)' : 'Đặt làm ảnh đại diện cho lô này'}
          >
            <Star className={cn('w-3 h-3', isReference ? 'fill-white' : '')} />
          </div>
        )}

        {/* People tag indicator */}
        {item.asset.ai_flags.has_people && (
          <span
            className="absolute left-1 bottom-1 w-1.5 h-1.5 rounded-full bg-warn z-10"
            title="Có người trong ảnh"
          />
        )}

        {/* Post-production indicator */}
        {item.asset.needs_post_production && (
          <span
            className="absolute right-1 bottom-1 w-2 h-2 rounded-full bg-amber-500 ring-1 ring-white/60 z-10"
            title="Cần hậu kỳ"
          />
        )}
      </button>
    );
  };

  // If batch groups are provided and there is at least one group with > 1 item
  const hasMultipleInAnyGroup = batchGroups && batchGroups.some((g) => g.indices.length > 1);

  if (batchGroups && hasMultipleInAnyGroup) {
    return (
      <div
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
        className={cn(
          'flex items-center gap-3 overflow-x-auto pb-2 pt-0.5 select-none filmstrip-scrollbar cursor-grab active:cursor-grabbing',
          className
        )}
      >
        {batchGroups.map((group) => {
          const isGroupAllSelected =
            group.items.length > 0 &&
            group.items.every((item) => selectedIds.has(item.id));

          return (
            <div
              key={group.key}
              className={cn(
                'flex flex-col gap-1 p-1 rounded-xl border transition-all flex-none',
                isGroupAllSelected
                  ? 'bg-verity/5 border-verity/40'
                  : 'bg-surface-2/60 border-border/60'
              )}
            >
              {/* Group header pill */}
              <div className="flex items-center justify-between gap-1 px-1.5 py-0.5 text-[10.5px]">
                <div className="flex items-center gap-1 min-w-0 text-text-2">
                  <FolderOpen className="w-3 h-3 text-text-3 flex-none" />
                  <span className="font-semibold truncate max-w-[120px]" title={group.label}>
                    {group.label}
                  </span>
                  <span className="text-text-3 flex-none">({group.indices.length})</span>
                </div>
                {group.indices.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (isGroupAllSelected) {
                        // Deselect group
                        onBatchSelect?.(
                          Array.from(selectedIds).filter((id) => !group.items.some((item) => item.id === id))
                        );
                      } else {
                        onBatchSelect?.(group.items.map((item) => item.id));
                      }
                    }}
                    className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-bold transition-all',
                      isGroupAllSelected
                        ? 'bg-verity text-white shadow-xs'
                        : 'bg-surface hover:bg-verity hover:text-white text-text-2 border border-border/80'
                    )}
                    title={isGroupAllSelected ? 'Bỏ chọn cả lô' : 'Chọn toàn bộ ảnh trong lô này'}
                  >
                    {isGroupAllSelected ? 'Đã chọn' : 'Chọn lô'}
                  </button>
                )}
              </div>

              {/* Group thumbnails */}
              <div className="flex items-center gap-1.5">
                {group.indices.map((idx) => items[idx] && renderThumbnail(items[idx], idx))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // Fallback default filmstrip if no groups
  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUpOrLeave}
      onMouseLeave={handleMouseUpOrLeave}
      className={cn(
        'flex items-center gap-2 overflow-x-auto pb-2 pt-0.5 select-none filmstrip-scrollbar cursor-grab active:cursor-grabbing',
        className
      )}
    >
      {items.map((item, idx) => renderThumbnail(item, idx))}
    </div>
  );
}
