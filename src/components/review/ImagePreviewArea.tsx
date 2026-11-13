'use client';

import React, { useState } from 'react';
import { MediaAsset } from '@/types/media';
import { VerityBadge } from '@/components/common/VerityBadge';
import { Filmstrip } from './Filmstrip';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, SplitSquareVertical, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { taxonomyLabel } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { buildPublicImageSlug } from '@/lib/image-slug';
import type { BatchGroup } from '@/hooks/useBatchGroups';
import type { SelectionMode } from '@/hooks/useBatchSelection';

interface ImagePreviewAreaProps {
  asset: MediaAsset;
  queueItems: { id: string; asset: MediaAsset }[];
  currentIndex: number;
  onSelectIndex: (index: number) => void;
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

export function ImagePreviewArea({
  asset,
  queueItems,
  currentIndex,
  onSelectIndex,
  batchGroups,
  selectedIds,
  referenceId,
  selectionMode,
  onBatchSelect,
  onToggleSelect,
  onRangeSelect,
  onSetReference,
  className,
}: ImagePreviewAreaProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [showCatalogGuide, setShowCatalogGuide] = useState(false);
  const { taxonomy } = useTaxonomy();
  const aiLabel = taxonomy.safety.find((entry) => entry.value === 'only_ai')?.label || 'Ảnh AI';
  const internalLabel = taxonomy.permission.find((entry) => entry.value === 'internal')?.label || 'Chỉ nội bộ';
  const peopleLabel = taxonomy.safety.find((entry) => entry.value === 'only_people')?.label || 'Có người';
  const brandLabel = taxonomyLabel(taxonomy, 'brand', asset.brand, asset.brand);
  const previewWidth = Number(asset.dimensions?.width) > 0 ? Number(asset.dimensions.width) : 0;
  const previewHeight = Number(asset.dimensions?.height) > 0 ? Number(asset.dimensions.height) : 0;
  const isPortrait = previewWidth > 0 && previewHeight > 0 && previewHeight > previewWidth;
  const previewAspectRatio = previewWidth > 0 && previewHeight > 0
    ? `${previewWidth} / ${previewHeight}`
    : '4 / 3';

  return (
    <div
      className={cn(
        'flex-1 flex flex-col gap-3 p-5 bg-paper min-w-0 min-h-0 overflow-hidden',
        className
      )}
    >
      {/* Main Image Stage
       * Wrapping the frame in a flex-1 stage guarantees Filmstrip always gets its
       * dedicated bottom slot regardless of image orientation.
       * For portrait assets, the frame scales by height (width: auto) so it hugs the
       * photo without giant empty letterbox margins.
       * For landscape assets, the frame scales by width (100%) so it preserves the
       * expected aspect ratio without exceeding the stage.
       */}
      <div className="flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
        <div
          data-testid="review-image-frame"
          className="relative max-h-full max-w-full flex-none rounded-2xl overflow-hidden border border-border bg-surface-2 min-h-0 flex items-center justify-center group shadow-sm"
          style={{
            aspectRatio: previewAspectRatio,
            width: isPortrait ? 'auto' : '100%',
            height: isPortrait ? '100%' : 'auto',
          }}
        >
        {/* The Media Content */}
        {asset.media_type === 'video' ? (
          <div className="relative w-full h-full flex items-center justify-center bg-black/40">
            <img
              src={asset.thumbnail_url}
              alt={asset.title}
              className="w-full h-full object-cover opacity-80"
            />
            <div className="absolute w-14 h-14 rounded-full bg-black/60 text-white grid place-items-center backdrop-blur-md shadow-lg cursor-pointer hover:scale-105 transition-transform">
              <Play className="w-6 h-6 ml-0.5 fill-white" />
            </div>
            {asset.duration && (
              <div className="absolute right-3 bottom-3 px-2 py-1 rounded bg-black/70 text-white font-mono text-[11px] backdrop-blur-sm">
                {asset.duration}
              </div>
            )}
          </div>
        ) : (
          <div
            className={cn(
              'w-full h-full flex items-center justify-center transition-transform duration-200',
              isZoomed ? 'cursor-zoom-out overflow-auto' : 'cursor-zoom-in'
            )}
            onClick={() => setIsZoomed(!isZoomed)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setIsZoomed((current) => !current);
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={isZoomed ? 'Thu nhỏ ảnh xem trước' : 'Phóng to ảnh xem trước'}
          >
            <img
              src={asset.thumbnail_url || asset.file_url}
              alt={asset.title}
              width={previewWidth || undefined}
              height={previewHeight || undefined}
              className={cn(
                'transition-all duration-300 select-none object-contain',
                isZoomed
                  ? 'max-w-none w-auto h-auto scale-150'
                  : 'max-w-full max-h-full w-auto h-auto'
              )}
            />
          </div>
        )}

        {/* Previous / next navigation keeps review movement one-click away. */}
        {queueItems.length > 1 && (
          <>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectIndex(Math.max(0, currentIndex - 1));
              }}
              disabled={currentIndex === 0}
              aria-label="Ảnh trước"
              title="Ảnh trước"
              className="absolute left-3 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/40 bg-black/45 text-white shadow-md backdrop-blur-sm transition-opacity hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelectIndex(Math.min(queueItems.length - 1, currentIndex + 1));
              }}
              disabled={currentIndex === queueItems.length - 1}
              aria-label="Ảnh tiếp theo"
              title="Ảnh tiếp theo"
              className="absolute right-3 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full border border-white/40 bg-black/45 text-white shadow-md backdrop-blur-sm transition-opacity hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          </>
        )}

        {/* Top-left Badges */}
        <div className="absolute left-3 top-3 flex items-center gap-2 z-10 max-w-[calc(100%-24px)]">
          <span
            className="font-mono text-[11px] font-semibold px-2.5 py-1 rounded-md bg-black/60 text-white backdrop-blur-md shadow-sm truncate max-w-[280px]"
            title={`${buildPublicImageSlug({ id: asset.id, brand: asset.brand, sku: asset.sku, title: asset.title })}.webp`}
          >
            {buildPublicImageSlug({ id: asset.id, brand: asset.brand, sku: asset.sku, title: asset.title })}.webp
          </span>
          {asset.ai_flags.tag_failed && (
            <VerityBadge variant="gold" size="sm">
              Tag tay
            </VerityBadge>
          )}
          {asset.ai_flags.is_ai && (
            <VerityBadge variant="ai" onPhoto size="sm">
              {aiLabel}
            </VerityBadge>
          )}
          {asset.permission === 'internal' && (
            <VerityBadge variant="private" onPhoto size="sm">
              {internalLabel}
            </VerityBadge>
          )}
          {asset.ai_flags.has_people && (
            <VerityBadge variant="warn" onPhoto size="sm">
              {peopleLabel}
            </VerityBadge>
          )}
          {asset.needs_post_production && (
            <VerityBadge variant="gold" onPhoto size="sm">
              Hậu kỳ
            </VerityBadge>
          )}
        </div>

        {/* Bottom-right Controls */}
        <div className="absolute right-3 bottom-3 flex items-center gap-2 z-10">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsZoomed(!isZoomed);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface hover:bg-surface-2 text-text-1 text-[12px] font-semibold shadow-sm border border-border transition-all"
          >
            {isZoomed ? (
              <>
                <ZoomOut className="w-3.5 h-3.5 text-text-2" />
                <span>Thu nhỏ</span>
              </>
            ) : (
              <>
                <ZoomIn className="w-3.5 h-3.5 text-text-2" />
                <span>Xem 1:1</span>
              </>
            )}
          </button>

          {asset.guide_url && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowCatalogGuide(!showCatalogGuide);
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold shadow-sm border transition-all',
                showCatalogGuide
                  ? 'bg-verity text-white border-verity'
                  : 'bg-surface hover:bg-surface-2 text-text-1 border-border'
              )}
            >
              <SplitSquareVertical className="w-3.5 h-3.5" />
              <span>So với ảnh catalog</span>
            </button>
          )}
        </div>

        {/* Catalog Guide Floating Window */}
        {showCatalogGuide && asset.guide_url && (
          <div className="absolute right-3 top-3 w-[220px] rounded-xl overflow-hidden bg-surface border border-border-strong shadow-pop z-20 animate-pop">
            <div className="relative h-[140px] bg-surface-2 overflow-hidden">
              <img
                src={asset.guide_url}
                alt="Catalog Guide"
                className="w-full h-full object-cover"
              />
              <span className="absolute left-2 top-2 px-1.5 py-0.5 rounded bg-black/60 text-white font-mono text-[9.5px]">
                Ảnh catalog gốc
              </span>
            </div>
            <div className="p-2.5">
              <div className="font-mono text-[12px] font-bold text-text-1 truncate">
                {asset.sku}
              </div>
              <div className="text-[11px] text-text-3 truncate">
                {brandLabel} · Tiêu chuẩn màu sắc & góc chụp
              </div>
            </div>
          </div>
        )}
      </div>
      </div>

      {/* Thumbnail Filmstrip */}
      <Filmstrip
        items={queueItems}
        currentIndex={currentIndex}
        onSelect={onSelectIndex}
        batchGroups={batchGroups}
        selectedIds={selectedIds}
        referenceId={referenceId}
        selectionMode={selectionMode}
        onBatchSelect={onBatchSelect}
        onToggleSelect={onToggleSelect}
        onRangeSelect={onRangeSelect}
        onSetReference={onSetReference}
      />
    </div>
  );
}
