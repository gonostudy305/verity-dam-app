'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { getNavigationItems, isNavigationItemActive, NavigationUser } from './navigation';
import { MoreSheet } from './MoreSheet';

interface MobileBottomNavProps {
  queueCount?: number;
  productIntakesEnabled?: boolean;
  duplicateCount?: number;
  reportCount?: number;
  currentUser: NavigationUser | null;
  onLogout: () => void;
  className?: string;
}

export function MobileBottomNav({ queueCount = 0, duplicateCount = 0, reportCount = 0, productIntakesEnabled = true, currentUser, onLogout, className }: MobileBottomNavProps) {
  const pathname = usePathname();
  const primaryItems = getNavigationItems(queueCount, currentUser, duplicateCount, reportCount, productIntakesEnabled).filter((item) => item.primary);

  return (
    <nav
      aria-label="Điều hướng chính trên điện thoại"
      data-testid="mobile-bottom-nav"
      className={cn('fixed inset-x-0 bottom-0 z-[var(--z-navigation)] flex min-h-[64px] items-stretch border-t border-border bg-surface px-1.5 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_18px_rgba(15,36,54,0.08)] md:hidden', className)}
    >
      {primaryItems.slice(0, 3).map((item) => {
        const Icon = item.icon;
        const active = isNavigationItemActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn('relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[10.5px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-inset', active ? 'text-verity-fg' : 'text-text-2 hover:text-text-1')}
          >
            <span className={cn('grid h-7 w-12 place-items-center rounded-full transition-colors', active && 'bg-verity-soft')}>
              <Icon aria-hidden="true" className="h-[19px] w-[19px]" />
            </span>
            <span className={cn('max-w-full truncate', active ? 'text-verity-fg' : 'text-text-2')}>
              {item.label === 'Thư viện' ? 'Thư viện' : item.label === 'Hàng chờ duyệt' ? 'Duyệt' : item.label}
            </span>
            {item.badge !== undefined ? (
              <span className="absolute left-1/2 top-1 -translate-x-[-10px] rounded-full bg-verity px-1.5 font-mono text-[9px] font-bold leading-4 text-white">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
      <MoreSheet currentUser={currentUser} onLogout={onLogout} />
    </nav>
  );
}
