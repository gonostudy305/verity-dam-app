'use client';

import React, { useState, useEffect } from 'react';
import { Search, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const SEARCH_MODE_DESCRIPTIONS: Record<string, string> = {
  'tìm kiếm cơ bản': 'Tìm kiếm chính xác theo từ khoá trực tiếp trong cơ sở dữ liệu.',
  'tìm kiếm thông minh': 'Tìm kiếm mở rộng: sửa lỗi gõ, bỏ dấu tiếng Việt, từ đồng nghĩa và nhận diện thực thể.',
  'tìm kiếm AI + ngữ nghĩa': 'Tìm kiếm kết hợp AI embedding và phân tích ngữ nghĩa hình ảnh.',
  'khớp liên kết / URL': 'Tra cứu chính xác ảnh theo đường dẫn CDN, WordPress, R2 hoặc storage path.',
  'basic search': 'Tìm kiếm chính xác theo từ khoá trực tiếp trong cơ sở dữ liệu.',
  'hybrid search': 'Tìm kiếm mở rộng: sửa lỗi gõ, bỏ dấu tiếng Việt, từ đồng nghĩa và nhận diện thực thể.',
  'hybrid + semantic': 'Tìm kiếm kết hợp AI embedding và phân tích ngữ nghĩa hình ảnh.',
};

interface SearchInputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit?: () => void;
  /** Truthful label for what the backend actually did with the current
   * query (Batch 2: search truthfulness) -- 'basic search' / 'tìm kiếm cơ bản' whenever the
   * intelligence path did not run, never a claim of hybrid/semantic that
   * isn't backed by search_meta.used / .semantic_active. */
  searchMode?: 'basic search' | 'hybrid search' | 'hybrid + semantic' | 'tìm kiếm cơ bản' | 'tìm kiếm thông minh' | 'tìm kiếm AI + ngữ nghĩa' | string;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  onSubmit,
  searchMode = 'tìm kiếm cơ bản',
  className,
}: SearchInputProps) {
  const placeholders = [
    'Tìm ảnh, dán link hoặc mã SKU để xem chi tiết...',
    'Tìm ảnh — thử “LHC4219”',
    'Tìm ảnh — thử “ly giữ nhiệt locknlock”',
    'Tìm ảnh — thử “hộp đựng thực phẩm llg428”',
    'Tìm ảnh — thử “nồi chiên không dầu ejf284blk”',
  ];

  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % placeholders.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className={cn('flex flex-col gap-2.5 px-3 pt-3 pb-2.5 sm:px-6 sm:pt-5 sm:pb-3', className)} suppressHydrationWarning>
      {/* Search Input Bar */}
      <div
        className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border-strong bg-surface px-3.5 shadow-sm transition-all focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20 sm:h-[50px] sm:gap-3 sm:px-4"
        suppressHydrationWarning
      >
        <Search className="w-4 h-4 text-text-3 flex-none" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSubmit?.();
            }
          }}
          placeholder={placeholders[placeholderIndex]}
          aria-label="Tìm kiếm ảnh"
          className="min-w-0 flex-1 bg-transparent border-0 outline-none text-[14px] text-text-1 placeholder:text-text-disabled sm:text-[15px]"
        />
        <span
          className="flex max-w-[92px] flex-none cursor-help select-none items-center gap-1 truncate rounded border border-border bg-surface-2 px-1.5 py-1 font-mono text-[10px] font-bold text-text-3 sm:max-w-none sm:px-2 sm:py-0.5 sm:text-[10.5px]"
          title={SEARCH_MODE_DESCRIPTIONS[searchMode] || searchMode}
        >
          <span className="truncate sm:hidden">Tìm kiếm</span>
          <span className="hidden truncate sm:inline">{searchMode}</span>
          <Info className="w-3 h-3 opacity-60 hover:opacity-100 transition-opacity" />
        </span>
      </div>
    </div>
  );
}
