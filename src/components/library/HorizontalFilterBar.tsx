'use client';

import React, { useState, useRef, useEffect } from 'react';
import { FilterState } from '@/types/media';
import { activeItems, type TaxonomyItem } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';
import { cn } from '@/lib/utils';
import {
  Building2,
  Filter,
  Tag,
  Home,
  Activity,
  Shield,
  ChevronDown,
  X,
  Search,
  RotateCcw,
  Check,
  Sparkles,
} from 'lucide-react';
import { ResponsiveDialogSheet } from '@/components/common/interaction-primitives';
import { ViewModeSwitcher, type ViewMode } from './ViewModeSwitcher';
import { FilterSidebar } from './FilterSidebar';

interface HorizontalFilterBarProps {
  filters: FilterState;
  onChange: (newFilters: FilterState) => void;
  onClear: () => void;
  totalResults?: number;
  sortOption: 'newest' | 'most_used' | 'unused';
  onSortChange: (sort: 'newest' | 'most_used' | 'unused') => void;
  density?: 'compact' | 'comfortable';
  onDensityChange?: (density: 'compact' | 'comfortable') => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  className?: string;
}

type OpenDropdown = 'category' | 'brand' | 'space' | 'status' | 'safety' | null;

export function HorizontalFilterBar({
  filters,
  onChange,
  onClear,
  totalResults = 0,
  sortOption,
  onSortChange,
  density = 'comfortable',
  onDensityChange,
  viewMode = 'justified',
  onViewModeChange,
  className,
}: HorizontalFilterBarProps) {
  const { taxonomy } = useTaxonomy();
  const [openDropdown, setOpenDropdown] = useState<OpenDropdown>(null);
  const [brandSearch, setBrandSearch] = useState('');
  const barRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click or Escape key
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const toggleDropdown = (name: OpenDropdown) => {
    setOpenDropdown((current) => (current === name ? null : name));
    if (name !== 'brand') setBrandSearch('');
  };

  const toggleArrayItem = (field: keyof FilterState, value: string) => {
    const current = (filters[field] as string[]) || [];
    const exists = current.includes(value);
    const updated = exists ? current.filter((v) => v !== value) : [...current, value];
    onChange({ ...filters, [field]: updated });
  };

  const clearGroup = (field: keyof FilterState) => {
    onChange({ ...filters, [field]: [] });
  };

  const toggleBooleanFlag = (flag: 'only_ai' | 'only_people' | 'only_internal' | 'only_needs_post_production') => {
    onChange({ ...filters, [flag]: !filters[flag] });
  };

  // Group options from taxonomy
  const categoryOptions = activeItems(taxonomy.category);
  const brandOptions = activeItems(taxonomy.brand);
  const spaceOptions = activeItems(taxonomy.space);
  const statusOptions = activeItems(taxonomy.status);
  const permissionOptions = activeItems(taxonomy.permission);

  // Filtered brand options by in-popover search
  const filteredBrands = brandOptions.filter((b) =>
    b.label.toLowerCase().includes(brandSearch.trim().toLowerCase())
  );

  // Active counts for badges
  const categoryCount = filters.category.length;
  const brandCount = filters.source.length;
  const spaceCount = filters.space.length;
  const statusCount = filters.status.length;
  const safetyCount =
    (filters.permission.length > 0 ? filters.permission.length : 0) +
    (filters.only_ai ? 1 : 0) +
    (filters.only_people ? 1 : 0) +
    (filters.only_internal ? 1 : 0) +
    (filters.only_needs_post_production ? 1 : 0);

  const totalActiveFilters =
    categoryCount + brandCount + spaceCount + statusCount + safetyCount;

  // Generate active chip list for bottom tag strip
  const activeChips: { id: string; label: string; onRemove: () => void }[] = [];

  filters.category.forEach((val) => {
    const label = categoryOptions.find((o) => o.value === val)?.label || val;
    activeChips.push({
      id: `cat-${val}`,
      label: `Loại: ${label}`,
      onRemove: () => toggleArrayItem('category', val),
    });
  });

  filters.source.forEach((val) => {
    const label = brandOptions.find((o) => o.value === val)?.label || val;
    activeChips.push({
      id: `brand-${val}`,
      label: `Hãng: ${label}`,
      onRemove: () => toggleArrayItem('source', val),
    });
  });

  filters.space.forEach((val) => {
    const label = spaceOptions.find((o) => o.value === val)?.label || val;
    activeChips.push({
      id: `space-${val}`,
      label: `Không gian: ${label}`,
      onRemove: () => toggleArrayItem('space', val),
    });
  });

  filters.status.forEach((val) => {
    const label = statusOptions.find((o) => o.value === val)?.label || val;
    activeChips.push({
      id: `status-${val}`,
      label: `Tình trạng: ${label}`,
      onRemove: () => toggleArrayItem('status', val),
    });
  });

  filters.permission.forEach((val) => {
    const label = permissionOptions.find((o) => o.value === val)?.label || val;
    activeChips.push({
      id: `perm-${val}`,
      label: `Quyền: ${label}`,
      onRemove: () => toggleArrayItem('permission', val),
    });
  });

  if (filters.only_ai) {
    activeChips.push({
      id: 'only_ai',
      label: 'Ảnh AI',
      onRemove: () => toggleBooleanFlag('only_ai'),
    });
  }
  if (filters.only_people) {
    activeChips.push({
      id: 'only_people',
      label: 'Có người',
      onRemove: () => toggleBooleanFlag('only_people'),
    });
  }
  if (filters.only_internal) {
    activeChips.push({
      id: 'only_internal',
      label: 'Chỉ nội bộ',
      onRemove: () => toggleBooleanFlag('only_internal'),
    });
  }
  if (filters.only_needs_post_production) {
    activeChips.push({
      id: 'only_needs_post_production',
      label: 'Cần Hậu kỳ',
      onRemove: () => toggleBooleanFlag('only_needs_post_production'),
    });
  }

  return (
    <div
      ref={barRef}
      className={cn(
        'px-3 py-2.5 sm:px-6 bg-surface border-b border-border select-none transition-all flex flex-col gap-2.5 relative z-40',
        className
      )}
    >
      {/* Top Filter Buttons & Sort/Result Controls */}
      <div className="flex items-center gap-2 md:hidden">
        <ResponsiveDialogSheet
          title="Bộ lọc thư viện"
          description="Chọn một hoặc nhiều tiêu chí. Kết quả sẽ cập nhật ngay khi đóng bộ lọc."
          contentClassName="mt-3"
          trigger={
            <button
              type="button"
              aria-label="Mở bộ lọc thư viện"
              className={cn(
                'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 text-[12.5px] font-bold shadow-2xs transition-colors',
                totalActiveFilters > 0
                  ? 'border-verity/40 bg-verity/10 text-verity'
                  : 'border-border bg-surface text-text-2 hover:bg-surface-2'
              )}
            >
              <Filter className="h-4 w-4" aria-hidden="true" />
              <span>Bộ lọc</span>
              {totalActiveFilters > 0 ? (
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-verity px-1 text-[10px] text-white">
                  {totalActiveFilters}
                </span>
              ) : null}
            </button>
          }
        >
          <FilterSidebar
            filters={filters}
            onChange={onChange}
            onClear={onClear}
            className="h-auto max-h-[min(60dvh,34rem)] w-full overflow-y-auto border-0 bg-transparent p-0"
          />
        </ResponsiveDialogSheet>

        <span className="min-w-[54px] text-center text-[11.5px] font-bold text-text-2">
          {totalResults} kết quả
        </span>

        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Sắp xếp thư viện</span>
          <select
            aria-label="Sắp xếp thư viện"
            value={sortOption}
            onChange={(event) => onSortChange(event.target.value as typeof sortOption)}
            className="min-h-11 w-full appearance-none rounded-xl border border-border bg-surface px-3 pr-8 text-[12px] font-semibold text-text-2 outline-none focus:border-verity focus:ring-2 focus:ring-verity/20"
          >
            <option value="newest">Mới nhất</option>
            <option value="most_used">Dùng nhiều</option>
            <option value="unused">Chưa dùng</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" aria-hidden="true" />
        </label>
      </div>

      <div className="hidden items-center justify-between gap-4 md:flex md:flex-wrap">
        {/* Left: Filter Dropdown Pills */}
        <div className="flex items-center flex-wrap gap-2">
          {/* 1. Loại ảnh (Category) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleDropdown('category')}
              aria-label="Lọc theo loại ảnh"
              aria-expanded={openDropdown === 'category'}
              className={cn(
                'flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12.5px] font-semibold transition-all shadow-2xs',
                categoryCount > 0
                  ? 'bg-verity/10 text-verity border-verity/40 font-bold'
                  : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong hover:text-text-1'
              )}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Loại ảnh</span>
              {categoryCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-verity text-white text-[10px] grid place-items-center font-bold">
                  {categoryCount}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-text-3 transition-transform duration-200',
                  openDropdown === 'category' && 'rotate-180 text-text-1'
                )}
              />
            </button>

            {openDropdown === 'category' && (
              <div className="absolute left-0 top-[40px] w-[230px] rounded-2xl bg-surface border border-border shadow-xl p-2 animate-fadeIn z-50 flex flex-col gap-1 max-h-[380px] overflow-y-auto">
                <div className="flex items-center justify-between px-2 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                  <span>Loại ảnh</span>
                  {categoryCount > 0 && (
                    <button
                      type="button"
                      onClick={() => clearGroup('category')}
                      className="text-verity hover:underline font-semibold"
                    >
                      Bỏ chọn
                    </button>
                  )}
                </div>
                {categoryOptions.map((opt) => {
                  const active = filters.category.includes(opt.value);
                  return (
                    <React.Fragment key={opt.value}>
                      <button
                        type="button"
                        onClick={() => toggleArrayItem('category', opt.value)}
                        className={cn(
                          'flex items-center justify-between px-2.5 py-1.5 rounded-xl text-[12.5px] font-semibold transition-colors text-left',
                          active
                            ? 'bg-verity/10 text-verity font-bold'
                            : 'hover:bg-hover text-text-1'
                        )}
                      >
                        <span>{opt.label}</span>
                        {active && <Check className="w-3.5 h-3.5 text-verity stroke-[2.5]" />}
                      </button>
                      {opt.subItems && opt.subItems.length > 0 && (
                        <div className="pl-3 py-0.5 flex flex-col gap-0.5 border-l-2 border-border/60 ml-3 mb-1">
                          {opt.subItems.map((sub) => {
                            const subActive = filters.category.includes(sub.value);
                            return (
                              <button
                                key={sub.value}
                                type="button"
                                onClick={() => toggleArrayItem('category', sub.value)}
                                className={cn(
                                  'flex items-center justify-between px-2 py-1 rounded-lg text-[11.5px] transition-colors text-left',
                                  subActive
                                    ? 'bg-verity/15 text-verity font-bold'
                                    : 'hover:bg-hover text-text-2 hover:text-text-1'
                                )}
                              >
                                <span>{sub.label}</span>
                                {subActive && <Check className="w-3 h-3 text-verity stroke-[2.5]" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          {/* 2. Thương hiệu (Brand) - With Search inside */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleDropdown('brand')}
              aria-label="Lọc theo thương hiệu"
              aria-expanded={openDropdown === 'brand'}
              className={cn(
                'flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12.5px] font-semibold transition-all shadow-2xs',
                brandCount > 0
                  ? 'bg-verity/10 text-verity border-verity/40 font-bold'
                  : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong hover:text-text-1'
              )}
            >
              <Tag className="w-3.5 h-3.5" />
              <span>Thương hiệu</span>
              {brandCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-verity text-white text-[10px] grid place-items-center font-bold">
                  {brandCount}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-text-3 transition-transform duration-200',
                  openDropdown === 'brand' && 'rotate-180 text-text-1'
                )}
              />
            </button>

            {openDropdown === 'brand' && (
              <div className="absolute left-0 top-[40px] w-[260px] max-h-[360px] rounded-2xl bg-surface border border-border shadow-xl p-2.5 animate-fadeIn z-50 flex flex-col gap-2">
                <div className="flex items-center justify-between px-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                  <span>Thương hiệu ({brandOptions.length})</span>
                  {brandCount > 0 && (
                    <button
                      type="button"
                      onClick={() => clearGroup('source')}
                      className="text-verity hover:underline font-semibold"
                    >
                      Bỏ chọn ({brandCount})
                    </button>
                  )}
                </div>

                {/* Instant Brand Search */}
                <div className="flex items-center gap-2 h-[32px] px-2.5 rounded-lg bg-surface-2 border border-border text-[12px] focus-within:border-verity">
                  <Search className="w-3.5 h-3.5 text-text-3 flex-none" />
                  <input
                    type="text"
                    value={brandSearch}
                    onChange={(e) => setBrandSearch(e.target.value)}
                    placeholder="Tìm nhanh thương hiệu..."
                    className="w-full bg-transparent border-0 outline-none text-text-1 placeholder:text-text-disabled"
                    autoFocus
                  />
                  {brandSearch && (
                    <button
                      type="button"
                      onClick={() => setBrandSearch('')}
                      className="text-text-3 hover:text-text-1"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Brand List */}
                <div className="flex-1 overflow-y-auto max-h-[240px] pr-1 space-y-0.5 divide-y-0">
                  {filteredBrands.length === 0 ? (
                    <div className="text-center py-4 text-[12px] text-text-disabled">
                      Không tìm thấy hãng nào khớp
                    </div>
                  ) : (
                    filteredBrands.map((b) => {
                      const active = filters.source.includes(b.value);
                      return (
                        <button
                          key={b.value}
                          type="button"
                          onClick={() => toggleArrayItem('source', b.value)}
                          className={cn(
                            'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                            active
                              ? 'bg-verity/10 text-verity font-bold'
                              : 'hover:bg-hover text-text-1'
                          )}
                        >
                          <span className="truncate">{b.label}</span>
                          {active && (
                            <Check className="w-3.5 h-3.5 text-verity stroke-[2.5] flex-none ml-2" />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 3. Không gian (Space) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleDropdown('space')}
              aria-label="Lọc theo không gian"
              aria-expanded={openDropdown === 'space'}
              className={cn(
                'flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12.5px] font-semibold transition-all shadow-2xs',
                spaceCount > 0
                  ? 'bg-verity/10 text-verity border-verity/40 font-bold'
                  : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong hover:text-text-1'
              )}
            >
              <Home className="w-3.5 h-3.5" />
              <span>Không gian</span>
              {spaceCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-verity text-white text-[10px] grid place-items-center font-bold">
                  {spaceCount}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-text-3 transition-transform duration-200',
                  openDropdown === 'space' && 'rotate-180 text-text-1'
                )}
              />
            </button>

            {openDropdown === 'space' && (
              <div className="absolute left-0 top-[40px] w-[210px] rounded-2xl bg-surface border border-border shadow-xl p-2 animate-fadeIn z-50 flex flex-col gap-1">
                <div className="flex items-center justify-between px-2 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                  <span>Không gian</span>
                  {spaceCount > 0 && (
                    <button
                      type="button"
                      onClick={() => clearGroup('space')}
                      className="text-verity hover:underline font-semibold"
                    >
                      Bỏ chọn
                    </button>
                  )}
                </div>
                {spaceOptions.map((opt) => {
                  const active = filters.space.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleArrayItem('space', opt.value)}
                      className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-xl text-[12.5px] font-medium transition-colors text-left',
                        active
                          ? 'bg-verity/10 text-verity font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>{opt.label}</span>
                      {active && <Check className="w-3.5 h-3.5 text-verity stroke-[2.5]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 4. Tình trạng (Status) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleDropdown('status')}
              aria-label="Lọc theo tình trạng"
              aria-expanded={openDropdown === 'status'}
              className={cn(
                'flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12.5px] font-semibold transition-all shadow-2xs',
                statusCount > 0
                  ? 'bg-verity/10 text-verity border-verity/40 font-bold'
                  : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong hover:text-text-1'
              )}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Tình trạng</span>
              {statusCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-verity text-white text-[10px] grid place-items-center font-bold">
                  {statusCount}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-text-3 transition-transform duration-200',
                  openDropdown === 'status' && 'rotate-180 text-text-1'
                )}
              />
            </button>

            {openDropdown === 'status' && (
              <div className="absolute left-0 top-[40px] w-[200px] rounded-2xl bg-surface border border-border shadow-xl p-2 animate-fadeIn z-50 flex flex-col gap-1">
                <div className="flex items-center justify-between px-2 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                  <span>Tình trạng</span>
                  {statusCount > 0 && (
                    <button
                      type="button"
                      onClick={() => clearGroup('status')}
                      className="text-verity hover:underline font-semibold"
                    >
                      Bỏ chọn
                    </button>
                  )}
                </div>
                {statusOptions.map((opt) => {
                  const active = filters.status.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleArrayItem('status', opt.value)}
                      className={cn(
                        'flex items-center justify-between px-2.5 py-1.5 rounded-xl text-[12.5px] font-medium transition-colors text-left',
                        active
                          ? 'bg-verity/10 text-verity font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>{opt.label}</span>
                      {active && <Check className="w-3.5 h-3.5 text-verity stroke-[2.5]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 5. Cờ an toàn & Quyền dùng (Safety & Permission) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleDropdown('safety')}
              aria-label="Lọc theo quyền và cờ an toàn"
              aria-expanded={openDropdown === 'safety'}
              className={cn(
                'flex items-center gap-1.5 h-[34px] px-3 rounded-xl border text-[12.5px] font-semibold transition-all shadow-2xs',
                safetyCount > 0
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40 font-bold'
                  : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong hover:text-text-1'
              )}
            >
              <Shield className="w-3.5 h-3.5" />
              <span>Quyền & Cờ an toàn</span>
              {safetyCount > 0 && (
                <span className="w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] grid place-items-center font-bold">
                  {safetyCount}
                </span>
              )}
              <ChevronDown
                className={cn(
                  'w-3 h-3 text-text-3 transition-transform duration-200',
                  openDropdown === 'safety' && 'rotate-180 text-text-1'
                )}
              />
            </button>

            {openDropdown === 'safety' && (
              <div className="absolute left-0 top-[40px] w-[230px] rounded-2xl bg-surface border border-border shadow-xl p-2.5 animate-fadeIn z-50 flex flex-col gap-2">
                {/* Permission Section */}
                <div>
                  <div className="px-1 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                    Quyền sử dụng
                  </div>
                  <div className="space-y-0.5">
                    {permissionOptions.map((opt) => {
                      const active = filters.permission.includes(opt.value);
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => toggleArrayItem('permission', opt.value)}
                          className={cn(
                            'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                            active
                              ? 'bg-verity/10 text-verity font-bold'
                              : 'hover:bg-hover text-text-1'
                          )}
                        >
                          <span>{opt.label}</span>
                          {active && (
                            <Check className="w-3.5 h-3.5 text-verity stroke-[2.5]" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Safety Flags Section */}
                <div className="pt-2 border-t border-border-subtle">
                  <div className="px-1 py-1 text-[11px] font-bold text-text-3 uppercase tracking-wider">
                    Cờ kiểm duyệt
                  </div>
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      onClick={() => toggleBooleanFlag('only_ai')}
                      className={cn(
                        'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                        filters.only_ai
                          ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>Ảnh AI</span>
                      {filters.only_ai && (
                        <Check className="w-3.5 h-3.5 text-purple-600 stroke-[2.5]" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleBooleanFlag('only_people')}
                      className={cn(
                        'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                        filters.only_people
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>Có người trong hình</span>
                      {filters.only_people && (
                        <Check className="w-3.5 h-3.5 text-amber-500 stroke-[2.5]" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleBooleanFlag('only_internal')}
                      className={cn(
                        'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                        filters.only_internal
                          ? 'bg-red-500/10 text-red-600 dark:text-red-400 font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>Chỉ nội bộ</span>
                      {filters.only_internal && (
                        <Check className="w-3.5 h-3.5 text-red-500 stroke-[2.5]" />
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => toggleBooleanFlag('only_needs_post_production')}
                      className={cn(
                        'w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors text-left',
                        filters.only_needs_post_production
                          ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 font-bold'
                          : 'hover:bg-hover text-text-1'
                      )}
                    >
                      <span>Cần Hậu kỳ</span>
                      {filters.only_needs_post_production && (
                        <Check className="w-3.5 h-3.5 text-amber-500 stroke-[2.5]" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Quick Clear All button if any filter is active */}
          {totalActiveFilters > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1 h-[34px] px-2.5 rounded-xl text-[12px] font-semibold text-text-3 hover:text-bad hover:bg-bad-soft/50 transition-colors"
              title="Xóa tất cả tiêu chí lọc"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Xóa bộ lọc</span>
            </button>
          )}
        </div>

        {/* Right: Results Count & Sort Switcher */}
        <div className="flex items-center gap-3 ml-auto">
          <span className="text-[12.5px] font-bold text-text-2 whitespace-nowrap">
            {totalResults} kết quả
          </span>

          <div className="flex items-center gap-1 bg-surface-2/80 p-0.5 rounded-xl border border-border">
            {([
              ['newest', 'Mới nhất'],
              ['most_used', 'Dùng nhiều'],
              ['unused', 'Chưa dùng'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onSortChange(value)}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-[11.5px] font-bold transition-all',
                  sortOption === value
                    ? 'bg-surface text-text-1 border border-border shadow-xs'
                    : 'text-text-3 hover:text-text-1 border border-transparent'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {onViewModeChange && (
            <ViewModeSwitcher viewMode={viewMode} onChange={onViewModeChange} />
          )}
        </div>
      </div>

      {/* Bottom: Active Filter Chips Strip (Only visible when filters are applied) */}
      {activeChips.length > 0 && (
        <div className="flex items-center flex-wrap gap-1.5 pt-1 border-t border-border-subtle animate-fadeIn">
          <span className="text-[11.5px] font-bold text-text-3 mr-1">Đang lọc:</span>
          {activeChips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1.5 h-[26px] pl-2.5 pr-1.5 rounded-full bg-verity/10 border border-verity/20 text-verity text-[11.5px] font-semibold shadow-2xs"
            >
              <span>{chip.label}</span>
              <button
                type="button"
                onClick={chip.onRemove}
                className="w-4 h-4 rounded-full hover:bg-verity/20 grid place-items-center transition-colors text-verity"
                title="Xóa tiêu chí này"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={onClear}
            className="text-[11.5px] text-text-3 hover:text-bad hover:underline font-semibold ml-2 cursor-pointer"
          >
            Xóa hết
          </button>
        </div>
      )}
    </div>
  );
}
