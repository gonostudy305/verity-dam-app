'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { BookOpen, LogOut, Sun, Moon } from 'lucide-react';
import { useTheme } from '@/components/common/ThemeToggle';
import { getNavigationItems, isNavigationItemActive } from './navigation';

interface NavigationRailProps {
  queueCount?: number;
  productIntakesEnabled?: boolean;
  duplicateCount?: number;
  reportCount?: number;
  currentUser: import('./navigation').NavigationUser | null;
  onLogout: () => void;
  className?: string;
}

export function NavigationRail({ queueCount = 0, duplicateCount = 0, reportCount = 0, productIntakesEnabled = true, currentUser, onLogout, className }: NavigationRailProps) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const navItems = getNavigationItems(queueCount, currentUser, duplicateCount, reportCount, productIntakesEnabled);
  const primaryItems = navItems.filter((item) => item.primary);
  const secondaryItems = navItems.filter((item) => !item.primary);

  const renderNavItem = (item: (typeof navItems)[number]) => {
    const Icon = item.icon;
    const active = isNavigationItemActive(pathname, item.href);
    return (
      <div key={item.href} className="group relative">
        <Link
          href={item.href}
          aria-label={item.label}
          aria-current={active ? 'page' : undefined}
          title={item.label}
          className={cn(
            'relative grid h-11 w-11 place-items-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
            active ? 'bg-verity-soft text-verity-fg' : 'text-text-3 hover:bg-hover hover:text-text-1'
          )}
        >
          <Icon aria-hidden="true" className="h-[19px] w-[19px]" />
          {item.badge !== undefined ? (
            <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-verity px-1 text-center font-mono text-[10px] font-bold leading-5 text-white">
              {item.badge}
            </span>
          ) : null}
        </Link>
        <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-text-1 px-2.5 py-1.5 text-[11px] font-semibold text-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {item.label}
        </span>
      </div>
    );
  };

  return (
    <aside
      aria-label="Điều hướng nhanh"
      data-testid="navigation-rail"
      className={cn('hidden h-full w-[64px] flex-none flex-col items-center border-r border-border bg-surface py-3 md:flex xl:hidden', className)}
    >
      <Link
        href="/library"
        aria-label="VerityDAM — Thư viện"
        className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-verity text-white shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
      >
        <span className="text-[17px] font-bold">V</span>
      </Link>

      <nav className="flex w-full flex-1 flex-col items-center gap-1" aria-label="Điều hướng chính">
        {primaryItems.map(renderNavItem)}

        <div className="mt-auto flex flex-col items-center gap-1 pt-3">
          <div className="mb-2 h-px w-8 bg-border-subtle" aria-hidden="true" />
          {secondaryItems.map(renderNavItem)}
          <div className="group relative">
            <Link
              href="/spec"
              aria-label="Ghi chú thiết kế"
              aria-current={pathname === '/spec' ? 'page' : undefined}
              title="Ghi chú thiết kế"
              className={cn(
                'grid h-11 w-11 place-items-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
                pathname === '/spec' ? 'bg-verity-soft text-verity-fg' : 'text-text-3 hover:bg-hover hover:text-text-1'
              )}
            >
              <BookOpen aria-hidden="true" className="h-[19px] w-[19px]" />
            </Link>
            <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-text-1 px-2.5 py-1.5 text-[11px] font-semibold text-surface opacity-0 shadow-md transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              Ghi chú thiết kế
            </span>
          </div>
        </div>
      </nav>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-border-subtle pt-3">
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Đổi giao diện Sáng / Tối"
          title={theme === 'dark' ? 'Giao diện Sáng' : 'Giao diện Tối'}
          className="grid h-11 w-11 place-items-center rounded-xl text-text-3 transition-colors hover:bg-hover hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity cursor-pointer"
        >
          {theme === 'dark' ? (
            <Sun className="h-[18px] w-[18px] text-gold-ink" />
          ) : (
            <Moon className="h-[18px] w-[18px]" />
          )}
        </button>
        <button
          type="button"
          onClick={onLogout}
          aria-label="Đăng xuất"
          title={currentUser?.email ? `Đăng xuất (${currentUser.email})` : 'Đăng xuất'}
          className="grid h-11 w-11 place-items-center rounded-xl text-text-3 transition-colors hover:bg-bad-soft hover:text-bad focus:outline-none focus-visible:ring-2 focus-visible:ring-verity cursor-pointer"
        >
          <LogOut aria-hidden="true" className="h-[18px] w-[18px]" />
        </button>
      </div>
    </aside>
  );
}
