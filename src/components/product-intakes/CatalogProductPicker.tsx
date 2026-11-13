'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import { apiRequest } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { CatalogProductSearchResult } from '@/types/media';

interface CatalogProductPickerProps {
  value: CatalogProductSearchResult | null;
  onChange: (product: CatalogProductSearchResult | null) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  className?: string;
}

/** Small, controlled catalog picker used before upload and at product review.
 * It deliberately searches the existing catalog only; picking no result is the
 * explicit path to propose a genuinely new identity. */
export function CatalogProductPicker({
  value,
  onChange,
  disabled = false,
  label = 'Dùng sản phẩm có sẵn',
  hint = 'Tìm theo SKU, hãng, tên hoặc model',
  className,
}: CatalogProductPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogProductSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2 || disabled) {
      setResults([]);
      setLoading(false);
      return;
    }

    let current = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      apiRequest<{ data: CatalogProductSearchResult[] }>(`/api/catalog/search?q=${encodeURIComponent(trimmed)}`)
        .then((response) => {
          if (!current) return;
          setResults(response.data || []);
          setOpen(true);
        })
        .catch(() => {
          if (current) setResults([]);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 250);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [disabled, query]);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  const choose = (product: CatalogProductSearchResult) => {
    onChange(product);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={cn('space-y-1.5', className)}>
      <label className="block text-[12px] font-bold text-text-2">{label}</label>
      {value ? (
        <div className="flex min-h-11 items-center gap-2 rounded-xl border border-ok-border bg-ok-soft/60 px-3 text-text-1">
          <Check aria-hidden="true" className="h-4 w-4 flex-none text-ok" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-[12px] font-bold">{value.primary_sku || value.code}</p>
            <p className="truncate text-[11px] text-text-2">{[value.brand, value.display_name || value.model_name].filter(Boolean).join(' · ')}</p>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-label="Bỏ chọn sản phẩm có sẵn"
            className="grid h-11 w-11 place-items-center rounded-lg text-text-3 transition-colors hover:bg-surface hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <div className="flex h-11 items-center gap-2 rounded-xl border border-border bg-surface px-3 transition-colors focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20">
            <Search aria-hidden="true" className="h-4 w-4 flex-none text-text-3" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onFocus={() => results.length > 0 && setOpen(true)}
              disabled={disabled}
              placeholder={hint}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-1 outline-none placeholder:text-text-3 disabled:cursor-not-allowed"
            />
            {loading ? <Loader2 aria-label="Đang tìm sản phẩm" className="h-4 w-4 flex-none animate-spin text-text-3" /> : null}
          </div>
          {open && query.trim().length >= 2 ? (
            <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-pop">
              {results.length > 0 ? results.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => choose(product)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11.5px] font-bold text-text-1">{product.primary_sku || product.code}</span>
                    <span className="block truncate text-[11px] text-text-2">{[product.brand, product.display_name || product.model_name].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="flex-none text-[11px] font-bold text-verity">Chọn</span>
                </button>
              )) : !loading ? (
                <p className="px-3 py-3 text-[12px] leading-relaxed text-text-3">Không có kết quả. Bạn có thể khai báo sản phẩm mới ở bên dưới.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
