'use client';

import React, { useState, useEffect, useRef } from 'react';
import { ShoppingBag, Star, Check, X, Loader2, Tag, Pencil, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/client/api';
import type { MediaAssetProductLink } from '@/types/media';
import { PRODUCT_ROLE_LABELS } from '@/lib/product-role';

interface CatalogProduct {
  id?: string;
  primary_sku: string;
  code?: string | null;
  display_name: string;
  brand?: string | null;
  model_name?: string | null;
  category?: string | null;
  catalog_sku_kind?: string | null;
}

interface DrawerProductHeroProps {
  currentSku?: string | null;
  catalogProduct?: CatalogProduct | null;
  products?: MediaAssetProductLink[];
  onProductAction?: (link: MediaAssetProductLink, action: 'confirm' | 'reject' | 'set_primary') => void;
  productActionId?: string | null;
  canEditSku?: boolean;
  onSkuChange?: (nextSku: string) => Promise<void> | void;
  isUpdatingSku?: boolean;
  className?: string;
}

export function DrawerProductHero({
  currentSku,
  catalogProduct,
  products = [],
  onProductAction,
  productActionId,
  canEditSku = false,
  onSkuChange,
  isUpdatingSku = false,
  className,
}: DrawerProductHeroProps) {
  const [isEditingSku, setIsEditingSku] = useState(false);
  const [skuSearchQuery, setSkuSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CatalogProduct[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const modelName = catalogProduct?.display_name || catalogProduct?.model_name;
  const brand = catalogProduct?.brand;

  useEffect(() => {
    if (!isEditingSku) {
      setSkuSearchQuery('');
      setSearchResults([]);
      return;
    }
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [isEditingSku]);

  useEffect(() => {
    const trimmed = skuSearchQuery.trim();
    if (trimmed.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let active = true;
    setIsSearching(true);
    const timer = setTimeout(() => {
      apiRequest<{ data: CatalogProduct[] }>(
        `/api/catalog/search?q=${encodeURIComponent(trimmed)}`
      )
        .then((res) => {
          if (!active) return;
          setSearchResults(res?.data || []);
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
  }, [skuSearchQuery]);

  const handleSelectSku = async (newSku: string) => {
    if (!onSkuChange) return;
    try {
      await onSkuChange(newSku);
      setIsEditingSku(false);
    } catch {
      // Error handled by parent toast
    }
  };

  // Filter out the primary product from the secondary list to prevent duplicate display
  const secondaryProducts = products.filter((p) => {
    if (p.role === 'primary' && p.code === catalogProduct?.primary_sku) return false;
    return true;
  });

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/80 bg-surface-2/40 p-4 space-y-3 transition-all',
        className
      )}
    >
      {/* Primary Product Identity */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {brand && (
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-surface-3 text-text-2 border border-border/70 uppercase">
                {brand}
              </span>
            )}
            {catalogProduct && (
              <span className="text-[10.5px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                <Check className="w-3 h-3" />
                <span>Khớp Catalog</span>
              </span>
            )}
            {canEditSku && !isEditingSku && (
              <button
                type="button"
                onClick={() => setIsEditingSku(true)}
                disabled={isUpdatingSku}
                className="text-[11px] font-semibold text-verity hover:underline flex items-center gap-1 cursor-pointer ml-1"
                title="Thay đổi mã SKU sản phẩm chính"
              >
                {isUpdatingSku ? (
                  <Loader2 className="w-3 h-3 animate-spin text-verity" />
                ) : (
                  <Pencil className="w-3 h-3" />
                )}
                <span>{currentSku ? 'Đổi SKU' : 'Gắn SKU'}</span>
              </button>
            )}
          </div>

          {modelName ? (
            <p className="text-[13px] font-medium text-text-1 leading-snug break-words pt-0.5">
              {modelName}
            </p>
          ) : (
            <p className="text-[12px] text-text-3 italic pt-0.5">
              Chưa có mô tả định danh từ Catalog
            </p>
          )}
        </div>

        <div className="w-8 h-8 rounded-xl bg-verity/10 text-verity grid place-items-center flex-none">
          <ShoppingBag className="w-4 h-4" />
        </div>
      </div>

      {/* SKU Edit / Search Box */}
      {isEditingSku && (
        <div className="p-3 rounded-xl border border-verity/40 bg-surface space-y-2 animate-fadeIn">
          <div className="flex items-center justify-between text-[11.5px] font-semibold text-text-2">
            <span>Tìm và đổi SKU Catalog</span>
            <button
              type="button"
              onClick={() => setIsEditingSku(false)}
              className="text-text-3 hover:text-text-1 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-text-3" />
            <input
              ref={searchInputRef}
              type="text"
              value={skuSearchQuery}
              onChange={(e) => setSkuSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsEditingSku(false);
                } else if (e.key === 'Enter' && skuSearchQuery.trim()) {
                  e.preventDefault();
                  handleSelectSku(skuSearchQuery.trim());
                }
              }}
              placeholder="Gõ mã SKU hoặc tên model..."
              disabled={isUpdatingSku}
              className="w-full pl-8 pr-8 py-1.5 rounded-lg border border-border bg-surface text-[12px] text-text-1 placeholder:text-text-3 focus:border-verity outline-none"
            />
            {isSearching && (
              <Loader2 className="absolute right-2.5 top-2.5 w-3.5 h-3.5 animate-spin text-verity" />
            )}
          </div>

          {searchResults.length > 0 && (
            <div className="max-h-44 overflow-y-auto divide-y divide-border border border-border/70 rounded-lg bg-surface-2/60">
              {searchResults.map((item) => (
                <button
                  key={item.id || item.primary_sku}
                  type="button"
                  disabled={isUpdatingSku}
                  onClick={() => handleSelectSku(item.primary_sku || item.code || '')}
                  className="w-full p-2 text-left hover:bg-surface-3 transition-colors flex items-center justify-between gap-2 cursor-pointer"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11.5px] font-bold text-text-1">
                        {item.primary_sku || item.code}
                      </span>
                      {item.brand && (
                        <span className="text-[10px] uppercase px-1 py-0.2 rounded bg-surface border border-border text-text-3">
                          {item.brand}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-2 truncate">{item.display_name || item.model_name}</p>
                  </div>
                  <span className="text-[10.5px] text-verity font-semibold shrink-0">Chọn</span>
                </button>
              ))}
            </div>
          )}

          {skuSearchQuery.trim().length >= 2 && !isSearching && searchResults.length === 0 && (
            <div className="flex items-center justify-between p-2 rounded-lg bg-surface-2 text-[11px] text-text-3">
              <span>Không có trong Catalog</span>
              <button
                type="button"
                disabled={isUpdatingSku}
                onClick={() => handleSelectSku(skuSearchQuery.trim())}
                className="text-verity hover:underline font-semibold cursor-pointer"
              >
                Dùng mã &quot;{skuSearchQuery.trim()}&quot;
              </button>
            </div>
          )}
        </div>
      )}

      {/* Secondary Products (Other products tagged in image) */}
      {secondaryProducts.length > 0 && (
        <div className="pt-2.5 border-t border-border/60 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-bold text-text-2 flex items-center gap-1.5">
              <Tag className="w-3 h-3 text-verity" />
              <span>Sản phẩm phụ trong ảnh ({secondaryProducts.length})</span>
            </span>
          </div>

          <div className="space-y-1.5">
            {secondaryProducts.map((link) => {
              const isActioning = productActionId === link.id;
              const isConfirmed = link.review_state === 'confirmed';
              const isRejected = link.review_state === 'rejected';

              return (
                <div
                  key={link.id}
                  className={cn(
                    'flex items-center justify-between gap-2 p-2 rounded-xl border bg-surface text-[12px] transition-all',
                    isRejected
                      ? 'opacity-50 border-border/40 bg-surface-2/40 line-through'
                      : isConfirmed
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : 'border-border'
                  )}
                >
                  <div className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="font-mono font-bold text-text-1">{link.code}</span>
                    {link.display_name && (
                      <span className="text-text-2 truncate text-[11.5px] max-w-[200px]">
                        · {link.display_name}
                      </span>
                    )}
                    <span className="text-[10px] text-text-3 px-1.5 py-0.2 rounded bg-surface-2 border border-border">
                      {PRODUCT_ROLE_LABELS[link.role] || link.role}
                    </span>
                  </div>

                  {/* Quick Confirmation Actions */}
                  {onProductAction && !isRejected && (
                    <div className="flex items-center gap-1 flex-none">
                      {!isConfirmed && (
                        <button
                          type="button"
                          disabled={isActioning}
                          onClick={() => onProductAction(link, 'confirm')}
                          title="Xác nhận liên kết sản phẩm này"
                          className="h-6 px-2 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[11px] font-semibold flex items-center gap-1 transition-all cursor-pointer"
                        >
                          {isActioning ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Check className="w-3 h-3" />
                          )}
                          <span>Xác nhận</span>
                        </button>
                      )}

                      <button
                        type="button"
                        disabled={isActioning}
                        onClick={() => onProductAction(link, 'reject')}
                        title="Từ chối sản phẩm này"
                        className="h-6 px-1.5 rounded-md hover:bg-red-500/10 text-text-3 hover:text-red-500 text-[11px] transition-all cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>

                      {link.role !== 'primary' && (
                        <button
                          type="button"
                          disabled={isActioning}
                          onClick={() => onProductAction(link, 'set_primary')}
                          title="Đặt làm sản phẩm chính của ảnh"
                          className="h-6 px-1.5 rounded-md hover:bg-amber-500/10 text-text-3 hover:text-amber-500 text-[11px] transition-all cursor-pointer"
                        >
                          <Star className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
