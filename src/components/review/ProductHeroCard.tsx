'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Sparkles, Star, AlertCircle, Search, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/client/api';
import type { SkuMatchResult } from '@/types/media';

export interface CatalogSearchResult {
  id: string;
  primary_sku: string;
  code: string | null;
  display_name: string;
  brand: string | null;
  model_name: string | null;
  category: string | null;
  catalog_sku_kind: string | null;
}

interface ProductHeroCardProps {
  sku: string | undefined;
  onSkuChange: (nextSku: string, item?: CatalogSearchResult) => void;
  isNonCatalog: boolean;
  onToggleNonCatalog: () => void;
  promoteReference: boolean;
  onTogglePromoteReference: (nextPromote: boolean) => void;
  effectiveCatalogIdentity?: {
    brand?: string;
    model_name?: string;
    display_name?: string;
    catalog_sku_kind?: string;
  } | null;
  skuMatch?: SkuMatchResult;
  confidence?: number | 'manual' | null;
  isEdited?: boolean;
  guideUrl?: string;
  disabled?: boolean;
  className?: string;
}

export function ProductHeroCard({
  sku = '',
  onSkuChange,
  isNonCatalog,
  onToggleNonCatalog,
  promoteReference,
  onTogglePromoteReference,
  effectiveCatalogIdentity,
  skuMatch,
  confidence,
  isEdited,
  guideUrl,
  disabled = false,
  className,
}: ProductHeroCardProps) {
  const [searchResults, setSearchResults] = useState<CatalogSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasSku = Boolean(sku && sku.trim());
  const isManualConfidence = confidence === 'manual';
  const normConf = typeof confidence === 'number' && Number.isFinite(confidence)
    ? (confidence > 0 && confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence))
    : null;

  const candidates = skuMatch?.candidates || [];
  const modelName = effectiveCatalogIdentity?.model_name || effectiveCatalogIdentity?.display_name;

  // Map candidates to their brand for clearer pills
  const catalogCandidatesMap = useMemo(() => {
    const map = new Map<string, { brand?: string; model_name?: string }>();
    if (Array.isArray(skuMatch?.catalog_candidates)) {
      for (const c of skuMatch.catalog_candidates) {
        if (c?.sku) {
          map.set(c.sku.trim().toLowerCase(), {
            brand: c.brand || undefined,
            model_name: c.model_name || undefined,
          });
        }
      }
    }
    return map;
  }, [skuMatch?.catalog_candidates]);

  // Debounced catalog search when user is typing in SKU input
  useEffect(() => {
    const trimmed = (sku || '').trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      setIsDropdownOpen(false);
      return;
    }

    let active = true;
    setIsSearching(true);

    const timer = setTimeout(() => {
      apiRequest<{ data: CatalogSearchResult[] }>(
        `/api/catalog/search?q=${encodeURIComponent(trimmed)}`
      )
        .then((res) => {
          if (!active) return;
          const items = res?.data || [];
          setSearchResults(items);
          if (document.activeElement === inputRef.current && items.length > 0) {
            setIsDropdownOpen(true);
          }
        })
        .catch(() => {
          if (!active) return;
          setSearchResults([]);
        })
        .finally(() => {
          if (active) setIsSearching(false);
        });
    }, 200);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [sku]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelectCatalogItem = (item: CatalogSearchResult) => {
    const nextSku = item.primary_sku || item.code || '';
    onSkuChange(nextSku, item);
    setIsDropdownOpen(false);
    setSearchResults([]);
  };

  return (
    <div
      className={cn(
        'rounded-2xl border transition-all p-3.5 space-y-2.5',
        isNonCatalog
          ? 'bg-amber-500/[0.04] border-amber-500/30'
          : isEdited
          ? 'bg-surface-2/80 border-learn/50 ring-1 ring-learn/20'
          : 'bg-surface-2/60 border-border/80 hover:border-border shadow-xs',
        className
      )}
    >
      {/* Card Header: compact status only. Keep the identity below so long model
          names never compete with the confidence badge for horizontal space. */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1 truncate">
          <Package className={cn('w-4 h-4 flex-none', isNonCatalog ? 'text-amber-500' : 'text-verity')} />
          <span className="text-[12px] font-bold text-text-2 tracking-wide uppercase flex-none">
            {isNonCatalog ? 'Ảnh bối cảnh' : 'Sản phẩm chính'}
          </span>

          {isEdited && (
            <span className="text-[10.5px] font-semibold text-learn animate-fadeIn flex-none">
              đã sửa
            </span>
          )}
        </div>

        {/* Confidence Badge: Only show when sku is present and not non-catalog */}
        {!isNonCatalog && hasSku && (
          isManualConfidence ? (
            <div
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold border bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400 flex-none animate-fadeIn"
              title="SKU được gán thủ công / ngoài gợi ý AI"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
              <span>Thủ công</span>
            </div>
          ) : normConf !== null ? (
            <div
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-semibold border flex-none transition-colors animate-fadeIn',
                normConf >= 85
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                  : normConf >= 50
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400'
              )}
              title={`Độ khớp nhận diện AI: ${normConf}%`}
            >
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  normConf >= 85 ? 'bg-emerald-500' : normConf >= 50 ? 'bg-amber-500' : 'bg-rose-500'
                )}
              />
              <span>{normConf}%</span>
            </div>
          ) : null
        )}
      </div>

      {/* Primary identity: model/product name is review-critical and must remain
          fully readable at narrow panel widths. */}
      {!isNonCatalog && (
        <div className="rounded-xl border border-border/80 bg-surface px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-3">
              Model / tên sản phẩm
            </span>
            {effectiveCatalogIdentity?.brand && (
              <span className="inline-flex max-w-full items-center rounded-md border border-border bg-surface-3 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-2">
                {effectiveCatalogIdentity.brand}
              </span>
            )}
          </div>
          {modelName ? (
            <p
              className="mt-1 text-[15px] font-semibold leading-5 text-text-1 whitespace-normal break-words"
              title={modelName}
            >
              {modelName}
            </p>
          ) : (
            <p className="mt-1 text-[13px] italic text-text-3">Chưa có tên model</p>
          )}
        </div>
      )}

      {/* Main Body: SKU */}
      {isNonCatalog ? (
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-surface border border-dashed border-amber-500/40">
          <div className="text-[12px] text-amber-700 dark:text-amber-300 font-medium">
            Ảnh toàn cảnh hoặc công trình chưa phân định SKU riêng lẻ.
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={onToggleNonCatalog}
            className="text-[11.5px] font-bold text-verity hover:underline px-2 py-1 cursor-pointer flex-none"
          >
            Gắn mã SKU
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* SKU Input Row with Autocomplete Dropdown */}
          <div ref={containerRef} className="relative">
            <div className="flex items-center gap-2">
              <div
                className={cn(
                  'flex-1 flex items-center px-3 h-10 rounded-xl border bg-surface transition-all',
                  disabled ? 'opacity-60 cursor-not-allowed' : 'focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20 border-border'
                )}
              >
                <Search className="w-4 h-4 text-text-3 mr-2 flex-none" />
                <input
                  ref={inputRef}
                  id="sku-input"
                  type="text"
                  value={sku}
                  disabled={disabled}
                  onChange={(e) => onSkuChange(e.target.value)}
                  onFocus={() => {
                    if (searchResults.length > 0) setIsDropdownOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsDropdownOpen(false);
                    }
                  }}
                  placeholder="Tìm SKU, tên model hoặc nhập mã (VD: A10, FD06...)"
                  className="w-full bg-transparent border-0 outline-none text-[13px] font-mono font-bold text-text-1 placeholder:font-sans placeholder:font-normal placeholder:text-text-3"
                />
                {isSearching && (
                  <Loader2 className="w-3.5 h-3.5 text-text-3 animate-spin flex-none ml-1.5" />
                )}
                {sku && !disabled && (
                  <button
                    type="button"
                    onClick={() => {
                      onSkuChange('');
                      setSearchResults([]);
                      setIsDropdownOpen(false);
                    }}
                    title="Xoá SKU"
                    className="p-1 rounded-md text-text-3 hover:text-text-1 hover:bg-surface-3 transition-colors ml-1 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Catalog Guide Thumbnail (if available) */}
              {guideUrl && (
                <div
                  className="w-10 h-10 rounded-xl overflow-hidden border border-border shadow-xs flex-none bg-surface"
                  title="Ảnh chuẩn catalog"
                >
                  <img src={guideUrl} alt="SKU Catalog Thumb" className="w-full h-full object-cover" />
                </div>
              )}
            </div>

            {/* Catalog Typeahead Dropdown */}
            {isDropdownOpen && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 z-30 mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-surface shadow-xl py-1 animate-fadeIn">
                <div className="px-3 py-1 text-[10px] font-semibold text-text-3 border-b border-border/40 uppercase tracking-wider">
                  Gợi ý từ kho Catalog ({searchResults.length})
                </div>
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectCatalogItem(item)}
                    className="w-full text-left px-3 py-2 text-[12px] hover:bg-surface-2 transition-colors flex items-center justify-between gap-2 cursor-pointer border-b border-border/20 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-text-1 text-[12.5px]">
                          {item.primary_sku}
                        </span>
                        {item.brand && (
                          <span className="text-[9.5px] uppercase font-bold text-text-2 px-1.5 py-0.2 rounded bg-surface-3 border border-border/60">
                            {item.brand}
                          </span>
                        )}
                        {item.model_name && item.model_name !== item.primary_sku && (
                          <span className="text-[11px] text-text-3 truncate font-medium">
                            {item.model_name}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-text-2 truncate mt-0.5" title={item.display_name}>
                        {item.display_name}
                      </p>
                    </div>
                    <span className="text-[11px] font-bold text-verity flex-none hover:underline">
                      Chọn
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Kind warning if catalog name is model name */}
          {skuMatch?.catalog_identity?.catalog_sku_kind === 'model_name' && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1 px-1">
              <AlertCircle className="w-3 h-3 flex-none" />
              <span>Tên trên kho hiện là tên Model, chưa phải mã SKU bao bì.</span>
            </p>
          )}
        </div>
      )}

      {/* Action Toggles: Non-catalog switch & AI Reference flag */}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {/* Toggle Non-Catalog */}
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleNonCatalog}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all cursor-pointer select-none',
            isNonCatalog
              ? 'bg-amber-500/15 border-amber-500/40 text-amber-700 dark:text-amber-300 font-semibold'
              : 'bg-surface hover:bg-surface-3 border-border text-text-3 hover:text-text-2'
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', isNonCatalog ? 'bg-amber-500' : 'bg-text-3/40')} />
          <span>{isNonCatalog ? 'Đã tắt SKU (Ảnh bối cảnh)' : 'Ảnh bối cảnh / Không SKU'}</span>
        </button>

        {/* Toggle AI Reference Star */}
        {!isNonCatalog && Boolean(sku) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onTogglePromoteReference(!promoteReference)}
            title="Sử dụng làm ảnh mẫu chuẩn để AI nhận diện các ảnh sau"
            className={cn(
              'inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all cursor-pointer select-none',
              promoteReference
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-800 dark:text-amber-200 font-bold shadow-xs'
                : 'bg-surface hover:bg-surface-3 border-border text-text-3 hover:text-text-2'
            )}
          >
            <Star
              className={cn(
                'w-3 h-3 transition-transform',
                promoteReference ? 'fill-amber-500 text-amber-500 scale-110' : 'text-text-3'
              )}
            />
            <span>{promoteReference ? 'Đã chọn làm Ảnh mẫu AI' : 'Đặt làm ảnh mẫu AI'}</span>
          </button>
        )}
      </div>

      {/* Candidate Pills — only alternatives (current SKU filtered out) */}
      {!isNonCatalog && (() => {
        const alternatives = candidates.filter(
          (c) => c.sku.trim().toLowerCase() !== (sku || '').trim().toLowerCase()
        ).slice(0, 5);
        if (alternatives.length === 0) return null;
        return (
          <div className="pt-1 border-t border-border/40 space-y-1.5">
            <div className="flex items-center justify-between text-[10.5px] text-text-3">
              <span className="flex items-center gap-1 font-medium">
                <Sparkles className="w-3 h-3 text-verity" />
                <span>Gợi ý AI khác:</span>
              </span>
              <span className="text-[10px]">Bấm để thay SKU</span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {alternatives.map((candidate) => {
                const simPercent = Math.round(candidate.similarity * 100);
                const candMeta = catalogCandidatesMap.get(candidate.sku.trim().toLowerCase());
                const brandLabel = candMeta?.brand;
                return (
                  <button
                    key={candidate.sku}
                    type="button"
                    disabled={disabled}
                    onClick={() => onSkuChange(candidate.sku)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-all cursor-pointer bg-surface hover:bg-surface-3 hover:border-verity/40 border-border text-text-2 hover:text-text-1"
                  >
                    {brandLabel && (
                      <span className="text-[9px] uppercase font-bold text-text-3 bg-surface-3 px-1 py-0.2 rounded border border-border/50">
                        {brandLabel}
                      </span>
                    )}
                    <span className="font-mono font-bold">{candidate.sku}</span>
                    <span className="text-[9.5px] text-text-3 font-mono">{simPercent}%</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
