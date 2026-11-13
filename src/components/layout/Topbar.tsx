'use client';

import React from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OverflowMenu, OverflowMenuItem } from '@/components/common/interaction-primitives';

interface TopbarProps {
  title: string;
  subtitle?: string;
  hideTitleOnMobile?: boolean;
  hideTitle?: boolean;
  onSelectDemoState?: (stateName: string) => void;
  className?: string;
}

export function Topbar({
  title,
  subtitle,
  hideTitleOnMobile,
  hideTitle,
  onSelectDemoState,
  className,
}: TopbarProps) {
  const demoScenarios = [
    { group: 'Hàng chờ duyệt' },
    { id: 'review-normal', label: 'Ảnh thường, AI tag tốt' },
    { id: 'review-dupe', label: 'Cảnh báo trùng 92%' },
    { id: 'review-low-conf', label: 'AI kém tự tin, có người' },
    { id: 'review-tag-fail', label: 'AI tag thất bại, tag tay' },
    { id: 'review-done', label: 'Đã duyệt hết hàng chờ' },
    { group: 'Thư viện' },
    { id: 'lib-skeleton', label: 'Đang tải (Skeleton grid)' },
    { id: 'lib-empty', label: 'Tìm 0 kết quả' },
    { id: 'lib-broken', label: 'Ảnh hỏng trong grid' },
  ];

  return (
    <header
      className={cn(
        'sticky top-0 z-[var(--z-topbar)] flex min-h-[52px] h-[52px] items-center gap-2.5 px-3 sm:gap-3 sm:px-4 lg:px-6 bg-surface border-b border-border select-none',
        className
      )}
    >
      <div className={cn(
        'min-w-0 flex-col shrink-0',
        hideTitle ? 'sr-only' : hideTitleOnMobile ? 'sr-only sm:not-sr-only sm:flex' : 'flex'
      )}>
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-text-1 sm:text-[16px]">
          {title}
        </h1>
        {subtitle && !hideTitle && (
          <span className="hidden truncate text-[12px] font-normal text-text-3 sm:block">
            {subtitle}
          </span>
        )}
      </div>

      {/* Dynamic Header Portal Slot for Child Pages (e.g. Queue Tabs + Progress) */}
      <div
        id="topbar-portal-slot"
        className={cn(
          'flex items-center min-w-0 flex-1 gap-2 overflow-hidden',
          hideTitle ? 'ml-0' : hideTitleOnMobile ? 'ml-0 sm:ml-3' : 'ml-1 sm:ml-3'
        )}
      />

      {/* Demo States Dropdown */}
      {onSelectDemoState && (
        <OverflowMenu
          trigger={
            <button
              type="button"
              aria-label="Mở kịch bản demo"
              className="hidden h-11 items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 text-[12px] font-medium text-text-2 transition-all hover:bg-surface hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity sm:flex sm:h-[32px] shrink-0"
            >
              <Sparkles aria-hidden="true" className="h-3.5 w-3.5 text-verity" />
              <span>Kịch bản demo</span>
              <ChevronDown aria-hidden="true" className="ml-0.5 h-3 w-3 opacity-70" />
            </button>
          }
        >
          {demoScenarios.map((scenario, index) => {
            if (scenario.group) {
              return (
                <div key={scenario.group + index} className="px-3 pb-1 pt-2 text-[10.5px] font-bold uppercase tracking-wider text-text-3">
                  {scenario.group}
                </div>
              );
            }
            return (
              <OverflowMenuItem
                key={scenario.id}
                onSelect={() => {
                  if (scenario.id) onSelectDemoState(scenario.id);
                }}
              >
                <span className="truncate">{scenario.label}</span>
              </OverflowMenuItem>
            );
          })}
        </OverflowMenu>
      )}
    </header>
  );
}
