'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Layers, Home, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VerityChip } from '@/components/common/VerityChip';
import type { TaxonomyItem } from '@/config/taxonomy';

interface ContextualTaxonomyProps {
  category: string | undefined;
  subCategory?: string | undefined;
  onCategoryChange: (category: string) => void;
  onSubCategoryChange?: (subCategory: string) => void;
  space: string | undefined;
  onSpaceChange: (space: string | undefined) => void;
  status: string | undefined;
  onStatusChange: (status: string) => void;
  categories: TaxonomyItem[];
  spaces: TaxonomyItem[];
  statuses: TaxonomyItem[];
  editedFields: Record<string, boolean>;
  isLowConf: (val: number | undefined) => boolean;
  confidence: {
    category?: number;
    space?: number;
    status?: number;
  };
  disabled?: boolean;
  className?: string;
}

export function ContextualTaxonomy({
  category = '',
  subCategory = '',
  onCategoryChange,
  onSubCategoryChange,
  space,
  onSpaceChange,
  status = '',
  onStatusChange,
  categories,
  spaces,
  statuses,
  editedFields,
  isLowConf,
  confidence,
  disabled = false,
  className,
}: ContextualTaxonomyProps) {
  // Contextual check: Do we naturally expect space and status?
  // Banner / Thiết kế / Studio are 2D or staged assets where room and installation status are usually irrelevant.
  const isMarketingOrStudio =
    category === 'Ảnh Thiết kế' ||
    category === 'Ảnh Studio' ||
    category === 'Banner' ||
    category === 'Studio';
  const hasSpaceOrStatusValue = Boolean(space || status);

  // Manual override to expand space/status even if marketing/studio
  const [manualExpand, setManualExpand] = useState(false);

  const shouldShowSpaceAndStatus = !isMarketingOrStudio || hasSpaceOrStatusValue || manualExpand;
  const activeCategoryItem = categories.find((c) => c.value === category);

  return (
    <div className={cn('space-y-3', className)}>
      {/* Category Selection (Loại ảnh) */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-verity" />
            <label className="text-[12px] font-bold text-text-2">Loại ảnh</label>
            {editedFields.category && (
              <span className="text-[10.5px] font-semibold text-learn animate-fadeIn">
                đã ghi nhận
              </span>
            )}
          </div>
        </div>

        {/* Tầng 1: 3 Nhóm lớn */}
        <div
          className={cn(
            'flex flex-wrap gap-1.5 p-0.5 rounded-lg transition-all',
            editedFields.category
              ? 'animate-learn-ring'
              : isLowConf(confidence.category)
              ? 'ring-1 ring-warn/60 rounded-lg'
              : ''
          )}
        >
          {categories.map((c) => {
            const isActive = category === c.value;
            return (
              <VerityChip
                key={c.value}
                active={isActive}
                onClick={() => {
                  if (disabled) return;
                  const nextCategory = isActive ? '' : c.value;
                  onCategoryChange(nextCategory);
                  if (nextCategory !== category && onSubCategoryChange) {
                    onSubCategoryChange('');
                  }
                }}
              >
                {c.label}
              </VerityChip>
            );
          })}
        </div>

        {/* Tầng 2: Nhánh nhỏ (Hiển thị khi nhóm lớn có subItems) */}
        {activeCategoryItem?.subItems && activeCategoryItem.subItems.length > 0 && (
          <div className="pt-1 flex flex-wrap items-center gap-1.5 pl-2.5 border-l-2 border-verity/50 animate-fadeIn">
            <span className="text-[11px] font-medium text-text-3 mr-1">Nhánh:</span>
            {activeCategoryItem.subItems.map((sub) => {
              const isSubActive = subCategory === sub.value;
              return (
                <button
                  key={sub.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    onSubCategoryChange?.(isSubActive ? '' : sub.value);
                  }}
                  className={cn(
                    'text-[11.5px] px-2.5 py-1 rounded-full border transition-all font-medium',
                    isSubActive
                      ? 'bg-verity text-white border-verity font-bold shadow-xs'
                      : 'bg-surface-2/60 hover:bg-surface-3 text-text-2 border-border hover:border-border-strong hover:text-text-1'
                  )}
                >
                  {sub.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Contextual Space & Status Section */}
      {shouldShowSpaceAndStatus ? (
        <div className="space-y-3 pt-1 border-t border-border/40 animate-fadeIn">
          {/* Space / Không gian */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Home className="w-3.5 h-3.5 text-text-3" />
                <label className="text-[12px] font-bold text-text-2">Không gian</label>
                {editedFields.space && (
                  <span className="text-[10.5px] font-semibold text-learn animate-fadeIn">
                    đã ghi nhận
                  </span>
                )}
              </div>
              {isMarketingOrStudio && (
                <button
                  type="button"
                  onClick={() => setManualExpand(false)}
                  className="text-[10.5px] text-text-3 hover:text-text-1 cursor-pointer"
                >
                  Thu gọn
                </button>
              )}
            </div>

            <div
              className={cn(
                'flex flex-wrap gap-1.5 p-0.5 rounded-lg transition-all',
                editedFields.space
                  ? 'animate-learn-ring'
                  : (!isMarketingOrStudio && isLowConf(confidence.space))
                  ? 'ring-1 ring-warn/60 rounded-lg'
                  : ''
              )}
            >
              {spaces.map((s) => {
                const isActive = space === s.value;
                return (
                  <VerityChip
                    key={s.value}
                    active={isActive}
                    onClick={() => {
                      if (disabled) return;
                      onSpaceChange(isActive ? undefined : s.value);
                    }}
                  >
                    {s.label}
                  </VerityChip>
                );
              })}
            </div>
          </div>

          {/* Status / Tình trạng */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-text-3" />
                <label className="text-[12px] font-bold text-text-2">Tình trạng</label>
                {editedFields.status && (
                  <span className="text-[10.5px] font-semibold text-learn animate-fadeIn">
                    đã ghi nhận
                  </span>
                )}
              </div>
            </div>

            <div
              className={cn(
                'flex flex-wrap gap-1.5 p-0.5 rounded-lg transition-all',
                editedFields.status
                  ? 'animate-learn-ring'
                  : (!isMarketingOrStudio && isLowConf(confidence.status))
                  ? 'ring-1 ring-warn/60 rounded-lg'
                  : ''
              )}
            >
              {statuses.map((st) => {
                const isActive = status === st.value;
                return (
                  <VerityChip
                    key={st.value}
                    active={isActive}
                    onClick={() => {
                      if (disabled) return;
                      onStatusChange(isActive ? '' : st.value);
                    }}
                  >
                    {st.label}
                  </VerityChip>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Subtle affordance to add space/status when in Banner/Studio mode */
        <div className="pt-0.5">
          <button
            type="button"
            onClick={() => setManualExpand(true)}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-3 hover:text-text-1 hover:bg-surface-2 px-2 py-1 rounded-md border border-transparent hover:border-border transition-all cursor-pointer"
          >
            <span>+ Gán không gian & tình trạng (tùy chọn)</span>
          </button>
        </div>
      )}
    </div>
  );
}
