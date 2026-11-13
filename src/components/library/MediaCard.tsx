'use client';

import React from 'react';
import { MediaAsset } from '@/types/media';
import { VerityBadge } from '@/components/common/VerityBadge';
import { Play, Copy, Check, AlertOctagon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';
import { useTaxonomy } from '@/hooks/useTaxonomy';

// ─── ImageWithSkeleton ────────────────────────────────────────────────────────
// Batch 8: this used to force every image into a fixed aspect-[4/3] box
// ("prevents Masonry layout shift" -- except the grid was never a real
// masonry layout to begin with, just a fixed-row CSS grid, so every
// portrait/panorama photo was center-cropped via object-cover with no way to
// see its real proportions). Now sized from the asset's own real
// dimensions (media_assets.dimensions, already returned by the API) when
// available, falling back to 4:3 only for assets with no recorded size.
// Shimmer shows while the thumbnail loads, image fades in when ready.

function ImageWithSkeleton({ src, alt, aspectRatio }: { src: string; alt: string; aspectRatio: number }) {
  const [loaded, setLoaded] = React.useState(false);
  const [errored, setErrored] = React.useState(false);

  return (
    <div className="relative w-full bg-surface-2 overflow-hidden" style={{ aspectRatio: String(aspectRatio) }}>
      {/* Shimmer skeleton */}
      {!loaded && !errored && (
        <div className="absolute inset-0 animate-pulse bg-gradient-to-r from-surface-2 via-surface to-surface-2 bg-[length:200%_100%]" />
      )}
      {errored ? (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-3">
          Không tải được
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          className={cn(
            'absolute inset-0 w-full h-full object-cover transition-all duration-300 group-hover:scale-[1.02]',
            loaded ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}
    </div>
  );
}

interface MediaCardProps {
  asset: MediaAsset;
  selected?: boolean;
  onToggleSelect?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  /** Batch 8: 'compact' packs more columns into the same row width; the
   * card's own internal layout (overlay, badges) is unchanged either way. */
  density?: 'compact' | 'comfortable';
  className?: string;
  style?: React.CSSProperties;
}

function MediaCardImpl({
  asset,
  selected = false,
  onToggleSelect,
  onClick,
  density = 'comfortable',
  className,
  style,
}: MediaCardProps) {
  const { showToast } = useToast();
  const { taxonomy } = useTaxonomy();
  const aiLabel = taxonomy.safety.find((entry) => entry.value === 'only_ai')?.label || 'Ảnh AI';
  const internalLabel = taxonomy.permission.find((entry) => entry.value === 'internal')?.label || 'Chỉ nội bộ';
  const peopleLabel = taxonomy.safety.find((entry) => entry.value === 'only_people')?.label || 'Có người';

  const { width, height } = asset.dimensions || { width: 0, height: 0 };
  const aspectRatio = width > 0 && height > 0 ? width / height : 4 / 3;

  const handleCopyLink = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(asset.file_url);
      showToast('Đã sao chép link ảnh vào clipboard', 'success');
    } catch {
      showToast('Không thể sao chép link ảnh. Hãy kiểm tra quyền trình duyệt.', 'warn');
    }
  };

  return (
    <article
      style={style}
      className={cn(
        'group relative inline-block w-full isolate rounded-xl overflow-hidden border bg-surface shadow-sm transition-all duration-200',
        selected
          ? 'border-verity ring-2 ring-verity/20 shadow-md'
          : 'border-border hover:border-border-strong hover:shadow-md hover:-translate-y-0.5',
        style ? 'mb-0' : density === 'compact' ? 'mb-2' : 'mb-3 sm:mb-3.5',
        'break-inside-avoid-column',
        className
      )}
    >
      {/* Photo / Media Container */}
      <div className="relative w-full overflow-hidden bg-surface-2 leading-none">
        {onToggleSelect && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect(e); }}
            aria-label={selected ? 'Bỏ chọn ảnh' : 'Chọn ảnh'}
            aria-pressed={selected}
            className={cn(
              'absolute right-1.5 top-1.5 z-25 flex h-9 w-9 items-center justify-center rounded-full transition-all focus-visible:opacity-100',
              selected
                ? 'opacity-100'
                : 'opacity-70 sm:opacity-0 sm:group-hover:opacity-100 hover:opacity-100'
            )}
          >
            <span
              className={cn(
                'flex h-[26px] w-[26px] items-center justify-center rounded-full border shadow-xs transition-transform',
                selected
                  ? 'bg-verity border-white text-white scale-105 shadow-sm'
                  : 'bg-black/40 border-white/80 text-white backdrop-blur-xs hover:bg-black/60 hover:scale-105'
              )}
            >
              {selected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onClick}
          aria-label={`Mở chi tiết ${asset.title || asset.sku || 'ảnh'}`}
          className="absolute inset-0 z-20 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-inset"
        />

        {asset.ai_flags.is_broken ? (
          <div className="w-full aspect-[4/3] flex flex-col items-center justify-center gap-2 bg-surface-2 text-text-3 p-4 text-center">
            <AlertOctagon className="w-7 h-7 text-bad/70" />
            <span className="text-[12px] font-semibold text-text-2">
              Không tải được ảnh
            </span>
            <span className="font-mono text-[10.5px] text-text-3">
              retry · 2 lần thất bại
            </span>
          </div>
        ) : (
          <ImageWithSkeleton src={asset.thumbnail_url} alt={asset.title} aspectRatio={aspectRatio} />
        )}

        {/* Video Icon & Duration */}
        {asset.media_type === 'video' && (
          <>
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="w-10 h-10 rounded-full bg-black/60 text-white grid place-items-center backdrop-blur-sm shadow-md">
                <Play className="w-4 h-4 ml-0.5 fill-white" />
              </div>
            </div>
            {asset.duration && (
              <div className="absolute right-2 bottom-2 px-1.5 py-0.5 rounded bg-black/70 text-white font-mono text-[10px] backdrop-blur-sm">
                {asset.duration}
              </div>
            )}
          </>
        )}

        {/* Always-on Flags (Top-Left) */}
        <div className="absolute left-2 top-2 flex flex-wrap gap-1 max-w-[calc(100%-44px)] z-10 pointer-events-none">
          {asset.has_open_report && (
            <VerityBadge variant="warn" onPhoto size="sm">
              Có báo lỗi
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

        {/* Hover / Focus Overlay with Scrim */}
        <div
          className={cn(
            'pointer-events-none absolute inset-0 z-10 flex flex-col justify-end p-2.5 bg-gradient-to-t from-black/85 via-black/30 to-transparent transition-opacity duration-150',
            selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          )}
        >
          {/* Top of overlay: Source Badge + Copy Link (selection checkbox is
              now the always-visible top-right control above) */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="px-2 py-0.5 rounded bg-white/20 text-white text-[10.5px] font-semibold backdrop-blur-sm">
              {asset.origin_info.source}
            </span>

            <div className="flex-1" />

            <button
              type="button"
              onClick={handleCopyLink}
              aria-label="Sao chép link ảnh"
              className="pointer-events-auto relative z-20 grid min-h-11 min-w-11 place-items-center gap-1 rounded bg-white/90 px-2 text-[10.5px] font-bold text-verity shadow-xs transition-colors hover:bg-white sm:flex"
            >
              <Copy className="w-3 h-3" />
              <span className="hidden sm:inline">Copy</span>
            </button>
          </div>

          {/* Bottom of overlay: SKU mono & Usage count */}
          <div className="flex items-center justify-between text-white text-[11px] pt-1 border-t border-white/15">
            <span className="font-mono font-bold truncate max-w-[65%]">
              {asset.sku || 'Chưa gắn SKU'}
            </span>
            <span className="text-[10px] text-white/75 font-mono">
              {asset.usage_count > 0 ? `${asset.usage_count} lần dùng` : 'Chưa dùng'}
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

// Memoised so a parent re-render (search typing, selection, drawer, toast)
// only re-renders the cards whose own props changed.
export const MediaCard = React.memo(MediaCardImpl);

interface MediaGridItemProps {
  asset: MediaAsset;
  selected: boolean;
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onOpenDetail: (asset: MediaAsset) => void;
  density?: 'compact' | 'comfortable';
  style?: React.CSSProperties;
}

/**
 * Binds the id-based grid callbacks to one card with stable identities, so
 * MediaCard's memo is not defeated by per-render inline arrow functions.
 */
export const MediaGridItem = React.memo(function MediaGridItem({
  asset,
  selected,
  onToggleSelect,
  onOpenDetail,
  density,
  style,
}: MediaGridItemProps) {
  const handleToggle = React.useCallback((e: React.MouseEvent) => onToggleSelect(asset.id, e), [onToggleSelect, asset.id]);
  const handleOpen = React.useCallback(() => onOpenDetail(asset), [onOpenDetail, asset]);
  return (
    <MediaCard
      asset={asset}
      selected={selected}
      onToggleSelect={handleToggle}
      onClick={handleOpen}
      density={density}
      style={style}
    />
  );
});
