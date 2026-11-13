'use client';

import React from 'react';
import { FilterState } from '@/types/media';
import { VerityChip as VerityChip } from '@/components/common/VerityChip';
import { Filter, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activeItems, type TaxonomyItem } from '@/config/taxonomy';
import { useTaxonomy } from '@/hooks/useTaxonomy';

interface FilterSidebarProps {
  filters: FilterState;
  onChange: (newFilters: FilterState) => void;
  onClear: () => void;
  className?: string;
}

export function FilterSidebar({
  filters,
  onChange,
  onClear,
  className,
}: FilterSidebarProps) {
  const { taxonomy } = useTaxonomy();
  const toggleArrayFilter = (field: keyof FilterState, value: string) => {
    const current = (filters[field] as string[]) || [];
    const exists = current.includes(value);
    const updated = exists
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [field]: updated });
  };

  const toggleBooleanFilter = (field: 'only_ai' | 'only_people' | 'only_internal' | 'only_needs_post_production') => {
    onChange({ ...filters, [field]: !filters[field] });
  };

  const filterGroups = [
    {
      title: 'Loại ảnh',
      field: 'category' as keyof FilterState,
      options: activeItems(taxonomy.category),
    },
    {
      title: 'Tình trạng',
      field: 'status' as keyof FilterState,
      options: activeItems(taxonomy.status),
    },
    {
      title: 'Không gian',
      field: 'space' as keyof FilterState,
      options: activeItems(taxonomy.space),
    },
    {
      title: 'Thương hiệu',
      field: 'source' as keyof FilterState,
      options: activeItems(taxonomy.brand),
    },
    {
      title: 'Quyền dùng',
      field: 'permission' as keyof FilterState,
      options: activeItems(taxonomy.permission),
    },
  ];

  const hasActiveFilters =
    filters.category.length > 0 ||
    filters.space.length > 0 ||
    filters.status.length > 0 ||
    filters.source.length > 0 ||
    filters.permission.length > 0 ||
    filters.media_type.length > 0 ||
    filters.only_ai ||
    filters.only_people ||
    filters.only_internal ||
    filters.only_needs_post_production;

  return (
    <div
      className={cn(
        'w-[220px] flex flex-col p-4 bg-surface border-r border-border h-full overflow-y-auto select-none',
        className
      )}
    >
      <div className="flex items-center justify-between pb-3 mb-3 border-b border-border-subtle">
        <div className="flex items-center gap-1.5 text-[13px] font-bold text-text-1">
          <Filter className="w-3.5 h-3.5 text-verity" />
          <span>Bộ lọc</span>
        </div>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClear}
            className="text-[11.5px] text-verity hover:underline font-semibold"
          >
            Xóa hết
          </button>
        )}
      </div>

      <div className="space-y-4">
        {filterGroups.map((group) => (
          <div key={group.title} className="space-y-2">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">
              {group.title}
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {group.options.map((opt: TaxonomyItem) => {
                const active = ((filters[group.field] as string[]) || []).includes(opt.value);
                return (
                  <VerityChip
                    key={opt.value}
                    active={active}
                    onClick={() => toggleArrayFilter(group.field, opt.value)}
                    className="min-h-11"
                  >
                    {opt.label}
                  </VerityChip>
                );
              })}
            </div>
          </div>
        ))}

        {/* Special Cờ An Toàn */}
        <div className="space-y-2 pt-2 border-t border-border-subtle">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-text-3">
            Cờ an toàn
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {activeItems(taxonomy.safety).map((flag) => (
              <VerityChip
                key={flag.value}
                active={Boolean(filters[flag.value as 'only_ai' | 'only_people' | 'only_internal'])}
                onClick={() => toggleBooleanFilter(flag.value as 'only_ai' | 'only_people' | 'only_internal')}
                className="min-h-11"
              >
                {flag.label}
              </VerityChip>
            ))}
            <VerityChip
              active={Boolean(filters.only_needs_post_production)}
              onClick={() => toggleBooleanFilter('only_needs_post_production')}
              className="min-h-11"
            >
              Cần Hậu kỳ
            </VerityChip>
          </div>
        </div>
      </div>
    </div>
  );
}
