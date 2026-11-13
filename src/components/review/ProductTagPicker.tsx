'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Search, X, Tag, Info, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/client/api';
import { PRODUCT_ROLE_LABELS, TAGGABLE_ROLES, type TaggableRole } from '@/lib/product-role';
import type { SkuContext } from '@/lib/sku-context';

export interface PendingProductTag {
  sku: string;
  role: TaggableRole;
  display_name: string;
  brand: string;
}

interface CatalogSearchResult {
  id: string;
  primary_sku: string;
  code: string | null;
  display_name: string;
  brand: string | null;
  model_name: string | null;
  category: string | null;
  catalog_sku_kind: string | null;
}

interface ProductTagPickerProps {
  tags: PendingProductTag[];
  onChange: (tags: PendingProductTag[]) => void;
  disabled?: boolean;
  primarySku?: string;
  context?: SkuContext;
  className?: string;
}

export function ProductTagPicker({
  tags,
  onChange,
  disabled = false,
  primarySku = '',
  context,
  className,
}: ProductTagPickerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [warningMsg, setWarningMsg] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setIsLoading(false);
      setIsOpen(false);
      return;
    }

    let active = true;
    setIsLoading(true);

    const timer = setTimeout(() => {
      apiRequest<{ data: CatalogSearchResult[] }>(
        `/api/catalog/search?q=${encodeURIComponent(trimmed)}`
      )
        .then((res) => {
          if (!active) return;
          setResults(res?.data || []);
          setIsOpen(true);
        })
        .catch(() => {
          if (!active) return;
          setResults([]);
        })
        .finally(() => {
          if (active) setIsLoading(false);
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (item: CatalogSearchResult) => {
    setWarningMsg(null);
    const sku = item.primary_sku || item.code || '';
    if (!sku) return;

    if (primarySku && sku.trim().toLowerCase() === primarySku.trim().toLowerCase()) {
      setWarningMsg(`"${sku}" đã là SKU chính của ảnh.`);
      return;
    }

    const alreadyExists = tags.some(
      (t) => t.sku.trim().toLowerCase() === sku.trim().toLowerCase()
    );
    if (alreadyExists) {
      setWarningMsg(`Sản phẩm "${sku}" đã được thêm vào danh sách.`);
      return;
    }

    if (tags.length >= 12) {
      setWarningMsg('Đã đạt giới hạn tối đa 12 sản phẩm phụ cho một ảnh.');
      return;
    }

    const newTag: PendingProductTag = {
      sku,
      role: 'secondary',
      display_name: item.display_name || item.model_name || sku,
      brand: item.brand || '',
    };

    onChange([...tags, newTag]);
    setQuery('');
    setResults([]);
    setIsOpen(false);
  };

  const handleRoleChange = (index: number, newRole: TaggableRole) => {
    const updated = tags.map((tag, i) => (i === index ? { ...tag, role: newRole } : tag));
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    setWarningMsg(null);
    onChange(tags.filter((_, i) => i !== index));
  };

  const isEmphasised = context === 'scene' || context === 'marketing';

  if (tags.length === 0 && !isExpanded) {
    return (
      <div className={cn('pt-0.5', className)}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setIsExpanded(true)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl border border-dashed border-border/80 hover:border-verity/50 bg-surface-2/40 hover:bg-surface-2/80 text-text-3 hover:text-text-2 transition-all text-[11.5px] cursor-pointer"
        >
          <span className="flex items-center gap-1.5 font-medium">
            <Tag className="w-3.5 h-3.5 text-text-3" />
            <span>+ Sản phẩm phụ (0)</span>
          </span>
          {isEmphasised && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 font-semibold flex-none">
              Ảnh cảnh/banner
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'rounded-xl border p-3 space-y-2.5 transition-all text-text-1 animate-fadeIn',
        isEmphasised
          ? 'bg-amber-500/5 border-amber-500/30'
          : 'bg-surface-2/60 border-border-subtle',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Tag className="w-3.5 h-3.5 text-verity flex-none" />
          <span className="text-[12px] font-bold text-text-2 flex-none">
            Sản phẩm phụ
          </span>
          {isEmphasised && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 font-semibold flex-none">
              Ảnh cảnh/banner
            </span>
          )}
          {tags.length > 0 && (
            <span className="text-[11px] font-semibold px-1.5 py-0.2 rounded-full bg-surface-3 text-text-2 border border-border flex-none">
              {tags.length}/12
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-none">
          {tags.length === 0 && (
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="w-6 h-6 grid place-items-center rounded-md text-text-3 hover:text-text-1 hover:bg-surface-3 transition-colors cursor-pointer"
              title="Ẩn bảng sản phẩm phụ"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Typeahead Search Input */}
      <div className="relative">
        <div
          className={cn(
            'flex items-center px-2.5 h-9 rounded-lg border bg-surface transition-all',
            disabled ? 'opacity-60 cursor-not-allowed' : 'focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20 border-border'
          )}
        >
          <Search className="w-3.5 h-3.5 text-text-3 mr-2 flex-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setWarningMsg(null);
            }}
            onFocus={() => {
              if (results.length > 0) setIsOpen(true);
            }}
            disabled={disabled || tags.length >= 12}
            placeholder={
              tags.length >= 12
                ? 'Đã đạt giới hạn 12 sản phẩm'
                : 'Tìm theo mã SKU, tên sản phẩm hoặc model...'
            }
            className="flex-1 bg-transparent border-0 outline-none text-[12px] text-text-1 placeholder:text-text-3 disabled:cursor-not-allowed"
          />
          {isLoading && <Loader2 className="w-3.5 h-3.5 text-text-3 animate-spin flex-none ml-1.5" />}
          {query && !isLoading && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setIsOpen(false);
              }}
              className="p-0.5 rounded hover:bg-hover text-text-3 hover:text-text-1"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Search Results Dropdown */}
        {isOpen && results.length > 0 && (
          <div className="absolute top-full left-0 right-0 z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg py-1 animate-fadeIn">
            {results.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item)}
                className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-2 transition-colors flex items-center justify-between gap-2 cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-text-1 text-[11.5px]">
                      {item.primary_sku}
                    </span>
                    {item.brand && (
                      <span className="text-[10px] uppercase font-semibold text-text-3 px-1 py-0.2 rounded bg-surface-3">
                        {item.brand}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-text-2 truncate mt-0.5">
                    {item.display_name || item.model_name}
                  </p>
                </div>
                <span className="text-[10.5px] font-semibold text-verity flex-none">
                  + Gắn
                </span>
              </button>
            ))}
          </div>
        )}

        {isOpen && !isLoading && query.trim().length >= 2 && results.length === 0 && (
          <div className="absolute top-full left-0 right-0 z-30 mt-1 rounded-lg border border-border bg-surface p-3 text-center text-[11.5px] text-text-3 shadow-lg">
            Không tìm thấy sản phẩm khớp với &quot;{query}&quot;. Chỉ có thể gắn sản phẩm có trong catalog.
          </div>
        )}
      </div>

      {warningMsg && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400 animate-fadeIn">
          {warningMsg}
        </p>
      )}

      {/* Rendered Tags List */}
      {tags.length > 0 && (
        <div className="space-y-1.5 pt-1">
          {tags.map((tag, idx) => (
            <div
              key={`${tag.sku}-${idx}`}
              className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface border border-border-subtle shadow-2xs animate-fadeIn"
            >
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <span className="font-mono text-[11.5px] font-bold text-text-1 truncate">
                  🏷️ {tag.sku}
                </span>
                {tag.brand && (
                  <span className="text-[10px] text-text-3 truncate">
                    ({tag.brand})
                  </span>
                )}
                <span className="text-[11px] text-text-2 truncate hidden sm:inline" title={tag.display_name}>
                  · {tag.display_name}
                </span>
              </div>

              <div className="flex items-center gap-1.5 flex-none">
                {/* Role Selector */}
                <select
                  value={tag.role}
                  onChange={(e) => handleRoleChange(idx, e.target.value as TaggableRole)}
                  disabled={disabled}
                  aria-label={`Vai trò của sản phẩm ${tag.sku}`}
                  className={cn(
                    'h-6 px-1.5 rounded text-[11px] font-medium border bg-surface-2 cursor-pointer transition-all outline-none',
                    disabled ? 'opacity-60 cursor-not-allowed' : 'hover:border-verity focus:border-verity text-text-2'
                  )}
                >
                  {TAGGABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {PRODUCT_ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>

                {/* Remove Button */}
                <button
                  type="button"
                  onClick={() => handleRemove(idx)}
                  disabled={disabled}
                  aria-label={`Xóa tag ${tag.sku}`}
                  className="w-6 h-6 rounded flex items-center justify-center text-text-3 hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
