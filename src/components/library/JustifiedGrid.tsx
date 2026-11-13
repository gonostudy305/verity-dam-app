'use client';

import React, { useState, useRef, useEffect } from 'react';
import { MediaAsset } from '@/types/media';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { useJustifiedLayout } from '@/hooks/useJustifiedLayout';
import { JustifiedRow } from './JustifiedRow';
import { Search, PlusCircle, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activeItems } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { useToast } from '@/components/common/Toast';
import { apiRequest, ClientApiError } from '@/lib/client/api';

interface JustifiedGridProps {
  items: MediaAsset[];
  loading?: boolean;
  searchQuery?: string;
  selectedIds: string[];
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onOpenDetail: (asset: MediaAsset) => void;
  onApplySuggestion?: (query: string) => void;
  density?: 'compact' | 'comfortable';
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  className?: string;
}

export function JustifiedGrid({
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
}: JustifiedGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useContainerWidth(containerRef);
  const { taxonomy } = useTaxonomy();
  const { showToast } = useToast();

  // Optimal Google Photos target height: 230px for desktop/tablet (220-240px range), 180px for mobile
  const isMobile = containerWidth > 0 && containerWidth < 640;
  const targetRowHeight = isMobile ? 180 : 230;
  const gap = isMobile ? 10 : 12;

  const rows = useJustifiedLayout({
    items,
    containerWidth,
    targetRowHeight,
    gap,
  });

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
    setReportReason(
      searchQuery
        ? `Tìm "${searchQuery}" nhưng không có ảnh khớp.`
        : 'Không tìm thấy ảnh phù hợp trong Thư viện.'
    );
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
        body: JSON.stringify({
          sku,
          brand: reportBrand.trim() || undefined,
          reason,
          query_origin: searchQuery || null,
        }),
      });
      setReportSubmitted(true);
      showToast('Đã thêm vào danh sách "Cần ảnh"', 'success');
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 403) {
        showToast('Bạn cần quyền Contributor trở lên để báo thiếu ảnh.', 'warn');
      } else {
        showToast(
          error instanceof Error ? error.message : 'Không thể gửi báo cáo thiếu ảnh.',
          'warn'
        );
      }
    } finally {
      setIsSubmittingReport(false);
    }
  };

  const suggestions = [
    ...activeItems(taxonomy.brand)
      .slice(0, 2)
      .flatMap((brand) =>
        activeItems(taxonomy.category)
          .slice(0, 2)
          .map((cat) => `${brand.label.toLowerCase()} ${cat.label.toLowerCase()}`)
      ),
    ...activeItems(taxonomy.space)
      .slice(0, 2)
      .map((space) => `showroom ${space.label.toLowerCase()}`),
  ].slice(0, 6);

  if (loading) {
    const skeletonRowCount = density === 'compact' ? 5 : 4;
    return (
      <div ref={containerRef} className={cn('px-4 sm:px-6 pb-24 w-full flex flex-col gap-3', className)}>
        {Array.from({ length: skeletonRowCount }).map((_, idx) => (
          <div
            key={idx}
            className="w-full rounded-xl bg-surface-2 border border-border animate-shimmer"
            style={{ height: `${targetRowHeight}px` }}
          />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div ref={containerRef} className="w-full px-4 sm:px-6">
        <div className="flex flex-col items-center justify-center p-12 text-center my-8 max-w-[500px] mx-auto animate-pop">
          <div className="w-14 h-14 rounded-full bg-surface-2 border border-border grid place-items-center text-text-3 mb-4 shadow-xs">
            <Search className="w-6 h-6" />
          </div>
          <h2 className="text-[17px] font-bold text-text-1 mb-1.5">
            {searchQuery
              ? `Không có ảnh nào khớp “${searchQuery}”`
              : 'Không có ảnh nào trong mục này'}
          </h2>
          <p className="text-[13px] text-text-2 mb-4 leading-relaxed">
            Thử tìm theo một trong các gợi ý gần đúng hoặc báo thiếu ảnh để kỹ thuật viên chụp bổ sung:
          </p>

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
                      SKU <strong>{reportSku.trim()}</strong> đã được thêm vào danh sách &quot;Cần ảnh&quot; kèm query gốc
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
      </div>
    );
  }

  return (
    <div ref={containerRef} className={cn('px-4 sm:px-6 pb-24 w-full flex flex-col', className)}>
      <div className="flex flex-col w-full" style={{ gap: `${gap}px` }}>
        {rows.map((row) => (
          <JustifiedRow
            key={row.id}
            row={row}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onOpenDetail={onOpenDetail}
            density={density}
            gap={gap}
          />
        ))}
      </div>

      {isLoadingMore && (
        <div className="w-full flex flex-col mt-3" style={{ gap: `${gap}px` }}>
          <div
            className="w-full rounded-xl bg-surface-2 border border-border animate-shimmer"
            style={{ height: `${targetRowHeight}px` }}
          />
        </div>
      )}

      <div ref={sentinelRef} className="h-4 w-full pointer-events-none" aria-hidden="true" />
    </div>
  );
}
