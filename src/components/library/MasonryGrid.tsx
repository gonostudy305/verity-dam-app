'use client';

import React, { useState, useRef, useEffect } from 'react';
import { MediaAsset } from '@/types/media';
import { MediaGridItem } from './MediaCard';
import { Search, PlusCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activeItems } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface MasonryGridProps {
  items: MediaAsset[];
  loading?: boolean;
  searchQuery?: string;
  selectedIds: string[];
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onOpenDetail: (asset: MediaAsset) => void;
  onApplySuggestion?: (query: string) => void;
  /** Batch 8: compact packs more (smaller) columns per row; comfortable is
   * the previous default column count. */
  density?: 'compact' | 'comfortable';
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  className?: string;
}

// Batch 8: was `grid grid-cols-*` -- every card forced into the same row
// height regardless of the photo's real proportions (see MediaCard's
// ImageWithSkeleton). CSS columns lets each card size to its own natural
// aspect ratio and stack top-to-bottom per column, which is what "masonry"
// actually means; break-inside-avoid-column on each card (in MediaCard.tsx)
// stops a card being split across two columns.
const COLUMNS_COMFORTABLE = 'columns-2 sm:columns-2 md:columns-3 lg:columns-4 xl:columns-5 2xl:columns-6 gap-3 sm:gap-3.5';
const COLUMNS_COMPACT = 'columns-3 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 2xl:columns-8 gap-2 sm:gap-2.5';

export function MasonryGrid({
  items,
  loading = false,
  searchQuery = '',
  selectedIds,
  onToggleSelect,
  onOpenDetail,
  onApplySuggestion,
  density = 'comfortable',
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
  className,
}: MasonryGridProps) {
  const { taxonomy } = useTaxonomy();
  const { showToast } = useToast();
  // Varied skeleton heights approximate the masonry effect while items are
  // still loading, instead of every placeholder being identical.
  const skeletonHeights = ['214px', '168px', '246px', '190px', '232px', '176px', '198px', '158px'];
  const columnsClass = density === 'compact' ? COLUMNS_COMPACT : COLUMNS_COMFORTABLE;

  // Batch 7: "Báo thiếu ảnh này" used to be a static Link to /shot with no
  // side effect at all -- the caption below claimed it would be "added to
  // the Need Shots list with the original query" but nothing was ever
  // created. This now really POSTs to /api/shot with query_origin set to
  // the exact search that returned zero results.
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportSku, setReportSku] = useState('');
  const [reportBrand, setReportBrand] = useState('');
  const [reportReason, setReportReason] = useState('');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: '400px 0px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, isLoadingMore]);

  const openReportModal = () => {
    setReportSku('');
    setReportBrand('');
    setReportReason(searchQuery ? `Tìm "${searchQuery}" nhưng không có ảnh khớp.` : 'Không tìm thấy ảnh phù hợp trong Thư viện.');
    setReportSubmitted(false);
    setShowReportModal(true);
  };

  const submitReport = async () => {
    const sku = reportSku.trim();
    const reason = reportReason.trim();
    if (!sku || !reason || isSubmittingReport) return;
    setIsSubmittingReport(true);
    try {
      await apiRequest('/api/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, brand: reportBrand.trim() || undefined, reason, query_origin: searchQuery || null }),
      });
      setReportSubmitted(true);
      showToast('Đã thêm vào danh sách "Cần ảnh"', 'success');
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 403) {
        showToast('Bạn cần quyền Contributor trở lên để báo thiếu ảnh.', 'warn');
      } else {
        showToast(error instanceof Error ? error.message : 'Không thể gửi báo cáo thiếu ảnh.', 'warn');
      }
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const suggestions = [
    ...activeItems(taxonomy.brand).slice(0, 2).flatMap((brand) =>
      activeItems(taxonomy.category).slice(0, 2).map((cat) => `${brand.label.toLowerCase()} ${cat.label.toLowerCase()}`)
    ),
    ...activeItems(taxonomy.space).slice(0, 2).map((space) => `showroom ${space.label.toLowerCase()}`),
  ].slice(0, 6);

  if (loading) {
    const skeletonCount = density === 'compact' ? 18 : 12;
    return (
      <div className={cn(columnsClass, 'px-4 sm:px-6 pb-24 w-full')}>
        {Array.from({ length: skeletonCount }).map((_, idx) => (
          <div
            key={idx}
            className="w-full mb-3 sm:mb-3.5 rounded-xl bg-surface-2 border border-border animate-shimmer break-inside-avoid-column"
            style={{ height: skeletonHeights[idx % skeletonHeights.length] }}
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center my-8 max-w-[500px] mx-auto animate-pop">
        <div className="w-14 h-14 rounded-full bg-surface-2 border border-border grid place-items-center text-text-3 mb-4 shadow-xs">
          <Search className="w-6 h-6" />
        </div>
        <h2 className="text-[17px] font-bold text-text-1 mb-1.5">
          {searchQuery ? `Không có ảnh nào khớp “${searchQuery}”` : 'Không có ảnh nào trong mục này'}
        </h2>
        <p className="text-[13px] text-text-2 mb-4 leading-relaxed">
          Thử tìm theo một trong các gợi ý gần đúng hoặc báo thiếu ảnh để kỹ thuật viên chụp bổ sung:
        </p>

        {/* Query Suggestions */}
        <div className="flex flex-wrap items-center justify-center gap-2 mb-6">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onApplySuggestion?.(s)}
              className="px-3 py-1.5 rounded-full border border-border bg-surface hover:bg-surface-2 text-verity hover:border-border-strong text-[12.5px] font-semibold transition-all shadow-xs"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Report Missing Shot */}
        <button
          type="button"
          onClick={openReportModal}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-verity hover:bg-verity-hover text-white text-[13px] font-bold shadow-sm transition-all"
        >
          <PlusCircle className="w-4 h-4" />
          <span>Báo thiếu ảnh này</span>
        </button>
        <span className="text-[11px] text-text-3 mt-2">
          Sẽ được thêm vào danh sách “Cần ảnh” kèm query gốc
        </span>

        {showReportModal && (
          <div
            className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
            onClick={() => setShowReportModal(false)}
          >
            <div
              className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 shadow-lg space-y-3 text-left"
              onClick={(event) => event.stopPropagation()}
            >
              {reportSubmitted ? (
                <>
                  <div className="flex items-center gap-2 text-ok">
                    <CheckCircle2 className="w-5 h-5" />
                    <h3 className="text-[14.5px] font-bold">Đã ghi nhận</h3>
                  </div>
                  <p className="text-[12.5px] text-text-2 leading-relaxed">
                    SKU <strong>{reportSku.trim()}</strong> đã được thêm vào danh sách "Cần ảnh" (Shot List) kèm query gốc
                    {searchQuery ? ` "${searchQuery}"` : ''}.
                  </p>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowReportModal(false)}
                      className="h-[36px] px-3.5 rounded-lg bg-verity hover:bg-verity-hover text-white text-[12.5px] font-bold transition-all"
                    >
                      Đóng
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-text-1">
                    <PlusCircle className="w-5 h-5 text-verity" />
                    <h3 className="text-[14.5px] font-bold">Báo thiếu ảnh</h3>
                  </div>
                  <p className="text-[12px] text-text-3">
                    SKU cần chụp bổ sung (bắt buộc)
                  </p>
                  <input
                    type="text"
                    value={reportSku}
                    onChange={(event) => setReportSku(event.target.value)}
                    placeholder="Ví dụ: SF-2201"
                    className="w-full h-[38px] px-3 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-verity"
                  />
                  <p className="text-[12px] text-text-3">Hãng (tùy chọn)</p>
                  <input
                    type="text"
                    value={reportBrand}
                    onChange={(event) => setReportBrand(event.target.value)}
                    placeholder="Ví dụ: Verity"
                    className="w-full h-[38px] px-3 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-verity"
                  />
                  <p className="text-[12px] text-text-3">Lý do / mô tả</p>
                  <textarea
                    value={reportReason}
                    onChange={(event) => setReportReason(event.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-verity resize-none"
                  />
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setShowReportModal(false)}
                      className="h-[36px] px-3.5 rounded-lg border border-border text-text-2 hover:bg-hover text-[12.5px] font-semibold transition-all"
                    >
                      Hủy
                    </button>
                    <button
                      type="button"
                      onClick={() => void submitReport()}
                      disabled={!reportSku.trim() || !reportReason.trim() || isSubmittingReport}
                      className="h-[36px] px-3.5 rounded-lg bg-verity hover:bg-verity-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-bold transition-all"
                    >
                      {isSubmittingReport ? 'Đang gửi…' : 'Gửi báo cáo'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={cn('px-4 sm:px-6 pb-24 w-full flex flex-col', className)}>
      <div className={cn(columnsClass, 'w-full')}>
        {items.map((item) => (
          <MediaGridItem
            key={item.id}
            asset={item}
            selected={selectedIds.includes(item.id)}
            onToggleSelect={onToggleSelect}
            onOpenDetail={onOpenDetail}
            density={density}
          />
        ))}
      </div>

      {/* Loading More Skeletons */}
      {isLoadingMore && (
        <div className={cn(columnsClass, 'w-full mt-3 sm:mt-3.5')}>
          {Array.from({ length: density === 'compact' ? 6 : 4 }).map((_, idx) => (
            <div
              key={idx}
              className="w-full mb-3 sm:mb-3.5 rounded-xl bg-surface-2 border border-border animate-shimmer break-inside-avoid-column"
              style={{ height: skeletonHeights[idx % skeletonHeights.length] }}
            />
          ))}
        </div>
      )}

      {/* Infinite Scroll Intersection Sentinel */}
      <div ref={sentinelRef} className="h-4 w-full pointer-events-none" aria-hidden="true" />
    </div>
  );
}
