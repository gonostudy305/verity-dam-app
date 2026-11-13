'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Maximize2,
  Search,
  Tag,
  Wrench,
  X,
} from 'lucide-react';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/common/Toast';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import type { MediaAsset } from '@/types/media';
import type { GroupedAssetReportCard, AssetReportReason } from '@/lib/server/asset-reports';

interface CatalogProduct {
  id?: string;
  primary_sku: string;
  code?: string | null;
  display_name: string;
  brand?: string | null;
  model_name?: string | null;
}

const REASON_LABELS: Record<AssetReportReason, { label: string; color: string }> = {
  wrong_sku: { label: 'Sai SKU', color: 'text-red-600 bg-red-500/10 border-red-500/20 dark:text-red-400' },
  wrong_recognition: { label: 'Nhận diện sai', color: 'text-amber-600 bg-amber-500/10 border-amber-500/20 dark:text-amber-400' },
  wrong_url: { label: 'Link ảnh lỗi', color: 'text-rose-600 bg-rose-500/10 border-rose-500/20 dark:text-rose-400' },
  other: { label: 'Khác', color: 'text-blue-600 bg-blue-500/10 border-blue-500/20 dark:text-blue-400' },
};

interface ReportFixModalProps {
  isOpen: boolean;
  card: GroupedAssetReportCard | null;
  onClose: () => void;
  onSuccess: (updatedAsset: MediaAsset) => void;
}

export function ReportFixModal({
  isOpen,
  card,
  onClose,
  onSuccess,
}: ReportFixModalProps) {
  const { showToast } = useToast();
  const { taxonomy } = useTaxonomy();

  // Form states
  const [sku, setSku] = useState('');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [space, setSpace] = useState('');
  const [needsPostProduction, setNeedsPostProduction] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');

  // SKU Catalog search states
  const [skuSearchQuery, setSkuSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>([]);
  const [isSearchingSku, setIsSearchingSku] = useState(false);
  const [isSkuSearchOpen, setIsSkuSearchOpen] = useState(false);
  const [matchedCatalogName, setMatchedCatalogName] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Status & modal states
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  // Reset and load full asset data when modal opens with a card
  useEffect(() => {
    if (!isOpen || !card) {
      setErrorMessage(null);
      setIsSkuSearchOpen(false);
      setIsLightboxOpen(false);
      return;
    }

    // Seed initial values from card.asset
    setSku(card.asset.sku || '');
    setTitle(card.asset.title || '');
    setNeedsPostProduction(Boolean(card.asset.needs_post_production));
    setCategory('');
    setSpace('');
    setResolutionNote('');
    setMatchedCatalogName(null);

    // Default note suggestions based on report reason
    const firstOpenReport = card.reports.find((r) => r.status === 'open' || r.status === 'in_review');
    if (firstOpenReport?.report_reason === 'wrong_sku') {
      setResolutionNote('Đã kiểm tra và cập nhật mã SKU chính xác.');
    } else if (firstOpenReport?.report_reason === 'wrong_recognition') {
      setResolutionNote('Đã hiệu chỉnh lại thông tin và nhận diện ảnh.');
    }

    // Fetch full MediaAsset to get current category, space, etc.
    let active = true;
    setIsLoadingDetails(true);
    apiRequest<{ data: MediaAsset }>(`/api/media/${card.media_asset_id}`)
      .then((res) => {
        if (active && res?.data) {
          const a = res.data;
          setSku(a.sku || '');
          setTitle(a.title || '');
          setCategory(a.category || '');
          setSpace(a.space || '');
          setNeedsPostProduction(Boolean(a.needs_post_production));

          // Look up catalog display name if SKU exists
          if (a.sku) {
            apiRequest<{ data: CatalogProduct | null }>(
              `/api/catalog/lookup?sku=${encodeURIComponent(a.sku)}`
            ).then((catRes) => {
              if (active && catRes?.data) {
                setMatchedCatalogName(catRes.data.display_name || catRes.data.model_name || null);
              }
            }).catch(() => {});
          }
        }
      })
      .catch(() => {
        // Fallback gracefully to card values
      })
      .finally(() => {
        if (active) setIsLoadingDetails(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, card]);

  // Catalog typeahead search
  useEffect(() => {
    const trimmed = skuSearchQuery.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setIsSearchingSku(false);
      return;
    }

    let active = true;
    setIsSearchingSku(true);
    const timer = setTimeout(() => {
      apiRequest<{ data: CatalogProduct[] }>(
        `/api/catalog/search?q=${encodeURIComponent(trimmed)}`
      )
        .then((res) => {
          if (active) setSearchResults(res?.data || []);
        })
        .catch(() => {
          if (active) setSearchResults([]);
        })
        .finally(() => {
          if (active) setIsSearchingSku(false);
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [skuSearchQuery]);

  const handleSelectCatalogSku = (product: CatalogProduct) => {
    setSku(product.primary_sku);
    setMatchedCatalogName(product.display_name || product.model_name || null);
    setIsSkuSearchOpen(false);
    setSkuSearchQuery('');
    setResolutionNote((prev) =>
      prev ? prev : `Đã cập nhật SKU sang "${product.primary_sku}" (${product.display_name})`
    );
  };

  const handleClearSku = () => {
    setSku('');
    setMatchedCatalogName(null);
  };

  const handleAction = async (action: 'resolve' | 'dismiss') => {
    if (!card || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    const reportIds = card.reports
      .filter((r) => r.status === 'open' || r.status === 'in_review')
      .map((r) => r.id);

    try {
      const payload = {
        media_asset_id: card.media_asset_id,
        report_ids: reportIds,
        action,
        resolution_note: resolutionNote.trim() || undefined,
        media_updates:
          action === 'resolve'
            ? {
                sku: sku.trim() || null,
                title: title.trim() || null,
                category: category.trim() || null,
                space: space.trim() || null,
                needs_post_production: needsPostProduction,
              }
            : undefined,
      };

      const res = await apiRequest<{
        success: boolean;
        data: { asset: MediaAsset; resolved_count: number };
      }>('/api/asset-reports/resolve-and-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.success && res.data?.asset) {
        showToast(
          action === 'resolve'
            ? `Đã cập nhật thông tin ảnh và đóng ${res.data.resolved_count} báo cáo thành công.`
            : `Đã bỏ qua ${res.data.resolved_count} báo cáo lỗi cho ảnh này.`,
          'success'
        );
        onSuccess(res.data.asset);
        onClose();
      } else {
        throw new Error('Không nhận được phản hồi hợp lệ từ máy chủ.');
      }
    } catch (err) {
      if (err instanceof ClientApiError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Không thể xử lý yêu cầu. Vui lòng thử lại.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // Lightbox keyboard dismissal
  useEffect(() => {
    if (!isLightboxOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsLightboxOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isLightboxOpen]);

  if (!isOpen || !card) return null;

  const openReports = card.reports.filter((r) => r.status === 'open' || r.status === 'in_review');

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 animate-fadeIn"
        onClick={onClose}
      >
        <div
          className="w-full max-w-4xl max-h-[92vh] rounded-3xl border border-border bg-surface shadow-2xl flex flex-col overflow-hidden animate-pop"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-surface-2/40 shrink-0">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                <Wrench className="h-4.5 w-4.5" />
              </div>
              <div>
                <h3 className="text-[15.5px] font-bold text-text-1 flex items-center gap-2">
                  <span>Chỉnh sửa & Xử lý báo lỗi</span>
                  {isLoadingDetails && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-3" />}
                </h3>
                <p className="text-[12px] text-text-3">
                  Đang xử lý {openReports.length} báo cáo cho ảnh này
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng modal"
              className="grid h-8.5 w-8.5 place-items-center rounded-xl text-text-3 hover:bg-hover hover:text-text-1 transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Main Modal Body: 2 Columns */}
          <div className="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-border">
            {/* Left Column: Image Preview & Reports Context (5 cols) */}
            <div className="lg:col-span-5 p-5 space-y-4 bg-surface-2/20 flex flex-col justify-between">
              <div className="space-y-4">
                {/* Image Card with Preview Button */}
                <div className="relative group rounded-2xl overflow-hidden border border-border bg-black/5 aspect-4/3 flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={card.asset.thumbnail_url || card.asset.file_url}
                    alt={card.asset.title}
                    className="w-full h-full object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => setIsLightboxOpen(true)}
                    className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 text-white text-[13px] font-semibold cursor-pointer backdrop-blur-xs"
                    title="Click để phóng to ảnh kích thước đầy đủ"
                  >
                    <Maximize2 className="h-4 w-4" />
                    <span>Xem ảnh lớn</span>
                  </button>
                </div>

                {/* Report Issues Box */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-[11.5px] font-semibold text-text-3 uppercase tracking-wider">
                    <span>Nội dung được báo lỗi</span>
                    <span>{card.reports.length} phản hồi</span>
                  </div>

                  <div className="space-y-2 max-h-[260px] overflow-y-auto pr-1">
                    {card.reports.map((rep) => {
                      const reasonMeta = REASON_LABELS[rep.report_reason] || REASON_LABELS.other;
                      return (
                        <div
                          key={rep.id}
                          className="rounded-xl border border-border/80 bg-surface p-3 space-y-1.5 shadow-2xs text-[12.5px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={cn(
                                'inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border',
                                reasonMeta.color
                              )}
                            >
                              {reasonMeta.label}
                            </span>
                            <span className="text-[11px] text-text-3">
                              {rep.reported_by_name || 'Người dùng'}
                            </span>
                          </div>

                          {rep.report_note && (
                            <p className="text-text-1 font-medium bg-surface-2/60 rounded-lg px-2.5 py-1.5 border border-border/40 italic">
                              "{rep.report_note}"
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Note on SEO URL safety */}
              <div className="pt-2 text-[11px] text-text-3/80 flex items-center gap-1.5 border-t border-border/60">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                <span>URL tệp ảnh được giữ nguyên, đảm bảo an toàn link bài viết (SEO).</span>
              </div>
            </div>

            {/* Right Column: Edit Form (7 cols) */}
            <div className="lg:col-span-7 p-6 space-y-5">
              {errorMessage && (
                <div className="flex items-start gap-2.5 rounded-2xl border border-red-200/80 bg-red-50/80 dark:bg-red-950/40 p-3.5 text-[12.5px] text-red-600 dark:text-red-400">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span className="flex-1 font-medium">{errorMessage}</span>
                </div>
              )}

              {/* Section 1: Catalog SKU Search & Picker */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[13px] font-bold text-text-1 flex items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5 text-amber-500" />
                    <span>Mã SKU Catalog</span>
                  </label>
                  {sku && (
                    <button
                      type="button"
                      onClick={handleClearSku}
                      className="text-[11.5px] text-red-500 hover:underline cursor-pointer"
                    >
                      Xóa SKU
                    </button>
                  )}
                </div>

                {/* Current Selected SKU display */}
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-[200px] flex items-center justify-between rounded-xl border border-border bg-surface px-3 py-2 text-[13px]">
                    <div className="truncate">
                      {sku ? (
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-text-1 bg-surface-2 px-2 py-0.5 rounded-md border border-border">
                            {sku}
                          </span>
                          {matchedCatalogName && (
                            <span className="text-[12px] text-text-2 truncate font-medium">
                              {matchedCatalogName}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-text-3 italic">Chưa gắn SKU catalog</span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setIsSkuSearchOpen(!isSkuSearchOpen);
                        setTimeout(() => searchInputRef.current?.focus(), 50);
                      }}
                      className="ml-2 text-[12px] font-semibold text-verity hover:underline shrink-0 cursor-pointer"
                    >
                      {isSkuSearchOpen ? 'Đóng tìm kiếm' : sku ? 'Đổi SKU' : 'Tìm & Gắn SKU'}
                    </button>
                  </div>
                </div>

                {/* SKU Search Dropdown Box */}
                {isSkuSearchOpen && (
                  <div className="rounded-2xl border border-amber-500/30 bg-surface shadow-lg p-3 space-y-2 animate-fadeIn">
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-3" />
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={skuSearchQuery}
                        onChange={(e) => setSkuSearchQuery(e.target.value)}
                        placeholder="Gõ mã SKU hoặc tên sản phẩm để tìm kiếm..."
                        className="w-full h-9 pl-9 pr-8 rounded-xl border border-border bg-surface-2 text-[13px] text-text-1 placeholder:text-text-3 outline-hidden focus:border-amber-500"
                      />
                      {isSearchingSku && (
                        <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-amber-500" />
                      )}
                    </div>

                    {/* Results list */}
                    <div className="max-h-48 overflow-y-auto divide-y divide-border/60">
                      {searchResults.length > 0 ? (
                        searchResults.map((item) => (
                          <div
                            key={item.primary_sku}
                            onClick={() => handleSelectCatalogSku(item)}
                            className="p-2.5 hover:bg-surface-2 rounded-xl cursor-pointer flex items-center justify-between gap-2 transition-colors"
                          >
                            <div className="truncate">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[12.5px] font-bold text-text-1">
                                  {item.primary_sku}
                                </span>
                                {item.brand && (
                                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface border border-border text-text-3">
                                    {item.brand}
                                  </span>
                                )}
                              </div>
                              <p className="text-[11.5px] text-text-3 truncate mt-0.5">
                                {item.display_name || item.model_name}
                              </p>
                            </div>
                            <span className="text-[11.5px] font-bold text-verity shrink-0">Chọn</span>
                          </div>
                        ))
                      ) : skuSearchQuery.trim().length >= 2 && !isSearchingSku ? (
                        <p className="text-center py-3 text-[12px] text-text-3 italic">
                          Không tìm thấy sản phẩm khớp với "{skuSearchQuery}"
                        </p>
                      ) : (
                        <p className="text-center py-2 text-[11.5px] text-text-3">
                          Nhập từ 2 ký tự để tìm kiếm trong danh mục sản phẩm
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Section 2: Title */}
              <div className="space-y-1.5">
                <label className="text-[13px] font-bold text-text-1">Tiêu đề ảnh</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Mô tả tiêu đề ảnh..."
                  className="w-full h-9 rounded-xl border border-border bg-surface px-3 text-[13px] text-text-1 outline-hidden focus:border-amber-500 transition-colors"
                />
              </div>

              {/* Section 3: Taxonomy Category & Space */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-bold text-text-1">Phân loại (Category)</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full h-9 rounded-xl border border-border bg-surface px-2.5 text-[12.5px] text-text-1 outline-hidden focus:border-amber-500 cursor-pointer"
                  >
                    <option value="">-- Chưa chọn --</option>
                    {(taxonomy?.category || []).map((cat) => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[12.5px] font-bold text-text-1">Không gian (Space)</label>
                  <select
                    value={space}
                    onChange={(e) => setSpace(e.target.value)}
                    className="w-full h-9 rounded-xl border border-border bg-surface px-2.5 text-[12.5px] text-text-1 outline-hidden focus:border-amber-500 cursor-pointer"
                  >
                    <option value="">-- Chưa chọn --</option>
                    {(taxonomy?.space || []).map((sp) => (
                      <option key={sp.value} value={sp.value}>
                        {sp.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Section 4: Post-production Flag */}
              <div className="flex items-center gap-2.5 p-3 rounded-xl border border-border bg-surface-2/40">
                <input
                  type="checkbox"
                  id="needs_post_prod_toggle"
                  checked={needsPostProduction}
                  onChange={(e) => setNeedsPostProduction(e.target.checked)}
                  className="h-4 w-4 rounded border-border text-amber-500 focus:ring-amber-500 cursor-pointer"
                />
                <label
                  htmlFor="needs_post_prod_toggle"
                  className="text-[12.5px] font-semibold text-text-1 cursor-pointer select-none"
                >
                  Yêu cầu Hậu kỳ (Ảnh cần retouch, xóa vật thể hoặc xử lý đồ họa thêm)
                </label>
              </div>

              {/* Section 5: Resolution Note */}
              <div className="space-y-1.5">
                <label className="text-[13px] font-bold text-text-1">
                  Ghi chú xử lý <span className="text-text-3 font-normal">(ghi vào nhật ký)</span>
                </label>
                <textarea
                  rows={2}
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  placeholder="Ghi chú tóm tắt lý do hoặc hành động điều chỉnh..."
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[12.5px] text-text-1 outline-hidden focus:border-amber-500 resize-none transition-colors"
                />
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between border-t border-border px-6 py-3.5 bg-surface shrink-0 gap-3">
            <button
              type="button"
              onClick={() => handleAction('dismiss')}
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-xl border border-slate-300 dark:border-slate-700 px-4 py-2 text-[12.5px] font-semibold text-slate-700 dark:text-slate-300 hover:bg-surface-2 transition-all cursor-pointer disabled:opacity-50"
              title="Đóng báo cáo mà không thay đổi thông tin ảnh (nếu báo lỗi không chính xác)"
            >
              <EyeOff className="h-4 w-4" />
              <span>Bỏ qua báo lỗi</span>
            </button>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-xl border border-border px-4 py-2 text-[12.5px] font-semibold text-text-2 hover:bg-surface-2 transition-all cursor-pointer disabled:opacity-50"
              >
                Hủy
              </button>

              <button
                type="button"
                onClick={() => handleAction('resolve')}
                disabled={isSubmitting}
                className="flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] px-5 py-2 text-[12.5px] font-bold text-white shadow-xs transition-all cursor-pointer disabled:opacity-50"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Đang lưu...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Lưu & Đánh dấu đã xử lý</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox for Full Size View */}
      {isLightboxOpen && (
        <div
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setIsLightboxOpen(false)}
        >
          <div
            className="relative max-w-5xl max-h-[90vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsLightboxOpen(false)}
              className="absolute -top-12 right-0 grid h-9 w-9 place-items-center rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors cursor-pointer"
              title="Đóng (Escape)"
            >
              <X className="h-5 w-5" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={card.asset.file_url || card.asset.thumbnail_url}
              alt={card.asset.title}
              className="max-h-[85vh] max-w-[90vw] object-contain rounded-xl shadow-2xl"
            />
            <p className="mt-3 text-white/80 text-[13px] font-medium text-center truncate max-w-lg">
              {card.asset.title}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
