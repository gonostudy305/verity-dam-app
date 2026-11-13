'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Sparkles, X, Clock, Layers, Loader2, Star, Search, SlidersHorizontal } from 'lucide-react';
import { ReviewQueueItem, MediaAsset } from '@/types/media';
import { apiRequest } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { TaggableRole } from '@/lib/product-role';

export interface CatalogSearchResult {
  id: string;
  code?: string;
  primary_sku?: string;
  display_name?: string;
  brand?: string;
  model_name?: string;
  category?: string;
  catalog_sku_kind?: string;
}

export interface QuickBatchActionBarProps {
  selectedItems: ReviewQueueItem[];
  referenceId: string | null;
  suggestedSku?: string;
  suggestedSkuConfidence?: number;
  suggestedBrand?: string;
  onSetReference: (id: string) => void;
  onApprove: (
    patch: Partial<MediaAsset>,
    corrections: string[],
    referenceQueueId?: string,
    productLinks?: { sku: string; role: TaggableRole }[],
    patchFields?: string[]
  ) => void;
  onReject: () => void;
  onSkip: () => void;
  onClearSelection: () => void;
  onToggleAdvanced?: () => void;
  isAdvancedOpen?: boolean;
  isSubmitting?: boolean;
  className?: string;
}

export function QuickBatchActionBar({
  selectedItems,
  referenceId,
  suggestedSku,
  suggestedSkuConfidence,
  suggestedBrand,
  onSetReference,
  onApprove,
  onReject,
  onSkip,
  onClearSelection,
  onToggleAdvanced,
  isAdvancedOpen = false,
  isSubmitting = false,
  className,
}: QuickBatchActionBarProps) {
  const [skuInput, setSkuInput] = useState(suggestedSku || '');
  const [catalogIdentity, setCatalogIdentity] = useState<{
    brand?: string;
    model_name?: string;
    display_name?: string;
  }>({});
  const [searchResults, setSearchResults] = useState<CatalogSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [promoteReference, setPromoteReference] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const count = selectedItems.length;
  const refItem = useMemo(() => {
    return selectedItems.find((item) => item.id === referenceId) || selectedItems[0] || null;
  }, [selectedItems, referenceId]);

  // Initial seed from suggested SKU or reference asset
  useEffect(() => {
    if (!skuInput) {
      if (suggestedSku) {
        setSkuInput(suggestedSku);
        if (suggestedBrand) {
          setCatalogIdentity((prev) => ({ ...prev, brand: suggestedBrand }));
        }
      } else if (refItem?.asset?.sku) {
        setSkuInput(refItem.asset.sku);
        if (refItem.asset.brand) {
          setCatalogIdentity((prev) => ({ ...prev, brand: refItem.asset.brand }));
        }
      }
    }
  }, [suggestedSku, suggestedBrand, refItem]);

  // Dynamic catalog lookup when skuInput changes
  useEffect(() => {
    const trimmed = skuInput.trim();
    if (!trimmed || trimmed.length < 2) {
      setCatalogIdentity({});
      setSearchResults([]);
      return;
    }

    let active = true;
    const timer = setTimeout(async () => {
      // 1. Direct exact lookup
      try {
        const res = await apiRequest<{
          data: { primary_sku: string; brand?: string; model_name?: string; display_name?: string } | null;
        }>(`/api/catalog/lookup?sku=${encodeURIComponent(trimmed)}`);
        if (active && res?.data) {
          setCatalogIdentity({
            brand: res.data.brand || undefined,
            model_name: res.data.model_name || undefined,
            display_name: res.data.display_name || undefined,
          });
        }
      } catch {
        // ignore
      }

      // 2. Search suggestions
      try {
        setIsSearching(true);
        const searchRes = await apiRequest<{ data: CatalogSearchResult[] }>(
          `/api/catalog/search?q=${encodeURIComponent(trimmed)}`
        );
        if (active && searchRes?.data) {
          setSearchResults(searchRes.data.slice(0, 5));
        }
      } catch {
        if (active) setSearchResults([]);
      } finally {
        if (active) setIsSearching(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [skuInput]);

  // Close dropdown when clicked outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to approve, Esc to clear
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        handleApproveFast();
      } else if (e.key === 'Escape') {
        if (isDropdownOpen) {
          setIsDropdownOpen(false);
        } else {
          onClearSelection();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const handleSelectCatalogItem = (item: CatalogSearchResult) => {
    const nextSku = item.primary_sku || item.code || '';
    setSkuInput(nextSku);
    setCatalogIdentity({
      brand: item.brand,
      model_name: item.model_name,
      display_name: item.display_name,
    });
    setIsDropdownOpen(false);
  };

  const handleApplySuggested = () => {
    if (suggestedSku) {
      setSkuInput(suggestedSku);
      if (suggestedBrand) {
        setCatalogIdentity((prev) => ({ ...prev, brand: suggestedBrand }));
      }
    }
  };

  const handleApproveFast = () => {
    if (isSubmitting || count === 0) return;
    const cleanSku = skuInput.trim();
    const patch: Partial<MediaAsset> = {
      sku: cleanSku || undefined,
      brand: catalogIdentity.brand || suggestedBrand || undefined,
      promote_reference: promoteReference,
    };
    const patchFields = ['sku', 'brand'];
    if (promoteReference) {
      patchFields.push('promote_reference');
    }
    const corrections = cleanSku ? ['sku'] : [];
    onApprove(patch, corrections, refItem?.id, undefined, patchFields);
  };

  if (count < 2) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        'fixed bottom-20 left-1/2 -translate-x-1/2 z-40 max-w-4xl w-[calc(100%-2rem)] md:w-auto',
        'bg-surface/95 dark:bg-surface-2/95 backdrop-blur-md border border-border-strong shadow-2xl rounded-2xl p-2 px-3 sm:px-4',
        'flex flex-wrap items-center justify-between gap-2.5 animate-slideUp transition-all',
        className
      )}
    >
      {/* 1. Selection counter & Reference thumbnail */}
      <div className="flex items-center gap-2 flex-none">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-verity/10 text-verity font-bold text-[12.5px]">
          <Layers className="w-3.5 h-3.5" />
          <span>{count} ảnh</span>
        </div>

        {refItem && (
          <div
            className="relative w-8 h-8 rounded-lg overflow-hidden border border-amber-500/50 bg-black/10 flex-none"
            title="Ảnh đại diện Reference (nạp vector chuẩn)"
          >
            <img
              src={refItem.asset.thumbnail_url}
              alt="Reference"
              className="w-full h-full object-cover"
            />
            <span className="absolute top-0 right-0 w-3 h-3 bg-amber-500 text-white rounded-bl-sm flex items-center justify-center text-[7.5px] font-bold">
              ★
            </span>
          </div>
        )}
      </div>

      {/* 2. AI Quick Chip (if available and different from input) */}
      {suggestedSku && skuInput.toLowerCase() !== suggestedSku.toLowerCase() && (
        <button
          type="button"
          onClick={handleApplySuggested}
          className="hidden lg:flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-50 dark:bg-sky-950/60 border border-sky-300 dark:border-sky-800 text-sky-700 dark:text-sky-300 text-[11.5px] font-semibold hover:bg-sky-100 transition-colors flex-none"
          title="Dùng gợi ý nhận diện AI cho cả lô"
        >
          <Sparkles className="w-3 h-3 text-sky-600" />
          <span>Dùng: <strong>{suggestedSku}</strong></span>
          {suggestedSkuConfidence ? (
            <span className="opacity-75 text-[10px]">({suggestedSkuConfidence}%)</span>
          ) : null}
        </button>
      )}

      {/* 3. SKU Input with Autocomplete */}
      <div className="relative flex-1 min-w-[200px] max-w-[320px]">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 w-3.5 h-3.5 text-text-3 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={skuInput}
            onChange={(e) => {
              setSkuInput(e.target.value);
              setIsDropdownOpen(true);
            }}
            onFocus={() => setIsDropdownOpen(true)}
            placeholder="Nhập hoặc đổi SKU lô..."
            className="w-full h-8 pl-8 pr-7 rounded-xl bg-surface border border-border text-[12.5px] font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-verity focus:ring-1 focus:ring-verity transition-all"
          />
          {skuInput && (
            <button
              type="button"
              onClick={() => {
                setSkuInput('');
                setCatalogIdentity({});
                inputRef.current?.focus();
              }}
              className="absolute right-2 p-0.5 text-text-3 hover:text-text-1 rounded-full"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Model Match Tag */}
        {catalogIdentity.model_name && (
          <div className="absolute -top-6 left-0 flex items-center gap-1 text-[10.5px] font-semibold text-text-2 bg-surface-2/90 px-2 py-0.5 rounded-md border border-border pointer-events-none truncate max-w-full">
            <span className="text-verity font-bold uppercase">{catalogIdentity.brand || 'Verity'}</span>
            <span className="truncate">{catalogIdentity.model_name}</span>
          </div>
        )}

        {/* Dropdown Suggestions */}
        {isDropdownOpen && searchResults.length > 0 && (
          <div className="absolute bottom-full mb-1 left-0 w-full rounded-xl bg-surface border border-border shadow-pop z-50 overflow-hidden py-1">
            {searchResults.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectCatalogItem(item)}
                className="w-full px-3 py-1.5 text-left text-[12px] hover:bg-hover flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <span className="font-mono font-bold text-text-1">{item.primary_sku || item.code}</span>
                  {item.model_name && (
                    <span className="ml-1.5 text-text-3 truncate">({item.model_name})</span>
                  )}
                </div>
                {item.brand && (
                  <span className="text-[10px] text-text-3 px-1 rounded bg-surface-2">{item.brand}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 4. Action Buttons */}
      <div className="flex items-center gap-1.5 flex-none">
        {/* Toggle Promote Reference */}
        <button
          type="button"
          onClick={() => setPromoteReference(!promoteReference)}
          className={cn(
            'h-8 px-2.5 rounded-xl border text-[11.5px] font-semibold flex items-center gap-1 transition-colors',
            promoteReference
              ? 'bg-amber-500/10 border-amber-500/40 text-amber-600 dark:text-amber-400'
              : 'border-border text-text-3 hover:text-text-2 hover:bg-hover'
          )}
          title="Đặt ảnh đại diện làm ảnh mẫu AI để nạp vector chuẩn"
        >
          <Star className={cn('w-3.5 h-3.5', promoteReference ? 'fill-amber-500 text-amber-500' : '')} />
          <span className="hidden sm:inline">Mẫu AI</span>
        </button>

        {/* Primary Approve Button */}
        <button
          type="button"
          onClick={handleApproveFast}
          disabled={isSubmitting}
          className="h-8 px-3.5 rounded-xl bg-verity hover:bg-verity-hover text-white text-[12.5px] font-bold shadow-xs flex items-center gap-1.5 transition-all disabled:opacity-60"
        >
          {isSubmitting ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-4 h-4 stroke-[3]" />
          )}
          <span>Duyệt {count} ảnh</span>
        </button>

        {/* Secondary: Skip */}
        <button
          type="button"
          onClick={onSkip}
          disabled={isSubmitting}
          className="h-8 px-2.5 rounded-xl border border-border-strong bg-surface text-text-2 hover:text-text-1 hover:bg-surface-2 text-[11.5px] font-semibold transition-colors hidden sm:inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
          title="Chuyển lô sang Để sau (S)"
        >
          <Clock className="w-3.5 h-3.5 text-text-2" />
          <span>Để sau</span>
        </button>

        {/* Secondary: Reject */}
        <button
          type="button"
          onClick={onReject}
          disabled={isSubmitting}
          className="h-8 px-2.5 rounded-xl border border-warn-border bg-warn-soft/40 text-warn hover:bg-warn-soft text-[11.5px] font-semibold transition-colors hidden sm:inline-flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-warn"
          title="Từ chối cả lô ảnh (R)"
        >
          <X className="w-3.5 h-3.5" />
          <span>Từ chối</span>
        </button>

        {/* Advanced Options Button */}
        {onToggleAdvanced && (
          <button
            type="button"
            onClick={onToggleAdvanced}
            className={cn(
              'h-8 px-2.5 rounded-xl border text-[11.5px] font-semibold flex items-center gap-1 transition-colors',
              isAdvancedOpen
                ? 'bg-surface-3 border-border-strong text-text-1'
                : 'border-border text-text-3 hover:text-text-1 hover:bg-hover'
            )}
            title="Mở rộng tùy chọn metadata chi tiết"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Nâng cao</span>
          </button>
        )}

        {/* Clear selection */}
        <button
          type="button"
          onClick={onClearSelection}
          className="h-8 w-8 rounded-xl border border-border text-text-3 hover:text-text-1 hover:bg-hover flex items-center justify-center transition-colors"
          title="Bỏ chọn (Esc)"
          aria-label="Bỏ chọn"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
