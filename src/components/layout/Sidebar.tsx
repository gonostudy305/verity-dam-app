'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  BookOpen,
  LogOut,
  Sun,
  Moon,
} from 'lucide-react';
import { useTheme } from '@/components/common/ThemeToggle';
import { getNavigationItems, isNavigationItemActive, NavigationUser } from './navigation';

interface SidebarProps {
  queueCount?: number;
  productIntakesEnabled?: boolean;
  duplicateCount?: number;
  reportCount?: number;
  currentUser: NavigationUser | null;
  onLogout: () => void;
  className?: string;
}

export function Sidebar({ queueCount = 0, duplicateCount = 0, reportCount = 0, productIntakesEnabled = true, currentUser, onLogout, className }: SidebarProps) {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const navItems = getNavigationItems(queueCount, currentUser, duplicateCount, reportCount, productIntakesEnabled);
  const primaryItems = navItems.filter((item) => item.primary);
  const secondaryItems = navItems.filter((item) => !item.primary);

  const renderNavItem = (item: (typeof navItems)[number]) => {
    const Icon = item.icon;
    const active = isNavigationItemActive(pathname, item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2.5 px-3 h-[38px] rounded-lg text-[13.5px] font-medium transition-all group',
          active
            ? 'bg-verity-soft text-verity-fg font-semibold'
            : 'text-text-2 hover:bg-hover hover:text-text-1'
        )}
      >
        <Icon
          className={cn(
            'w-[18px] h-[18px] flex-none transition-colors',
            active ? 'text-verity-fg' : 'text-text-3 group-hover:text-text-2'
          )}
        />
        <span className="flex-1 truncate">{item.label}</span>
        {item.badge !== undefined && (
          <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded-full bg-verity text-white">
            {item.badge}
          </span>
        )}
      </Link>
    );
  };

  return (
    <aside
      className={cn(
        'hidden xl:flex flex-none flex-col gap-1 w-[236px] h-full p-3 bg-surface border-r border-border overflow-y-auto select-none',
        className
      )}
    >
      {/* Brand Header */}
      <div className="flex items-center gap-2.5 px-2 py-2 mb-2">
        <div className="relative w-8 h-8 rounded-lg bg-verity grid place-items-center text-white font-bold text-[15px] flex-none shadow-sm">
          <span>V</span>
          {/* Verified accent */}
          <span className="absolute bottom-1.5 w-1.5 h-1.5 rounded-[1px] bg-ok" />
        </div>
        <div className="flex flex-col leading-tight overflow-hidden">
          <span className="font-bold text-[14.5px] tracking-tight text-text-1 truncate">
            VerityDAM
          </span>
          <span className="text-[11px] text-text-3 font-medium truncate">
            Visual Asset Intelligence
          </span>
        </div>
      </div>

      {/* Main Nav */}
      <nav className="flex flex-col gap-0.5 flex-1">
        {primaryItems.map(renderNavItem)}

        <div className="mt-auto pt-4">
          <div className="mb-3 border-t border-border-subtle" />
          <div className="flex flex-col gap-0.5">
            {secondaryItems.map(renderNavItem)}
          </div>

          {/* Spec / Design docs */}
          <Link
            href="/spec"
            aria-current={pathname === '/spec' ? 'page' : undefined}
            className={cn(
              'mt-1 flex items-center gap-2.5 px-3 h-[38px] rounded-lg text-[13px] font-medium transition-all group',
              pathname === '/spec'
                ? 'bg-verity-soft text-verity-fg font-semibold'
                : 'text-text-2 hover:bg-hover hover:text-text-1'
            )}
          >
            <BookOpen className="w-[18px] h-[18px] flex-none text-text-3 group-hover:text-text-2" />
            <span className="flex-1 truncate">Ghi chú thiết kế</span>
          </Link>
        </div>
      </nav>

      {/* User Section */}
      <div className="flex items-center justify-between p-2 mt-auto rounded-xl border border-border bg-surface-2/60">
        <div className="flex items-center gap-2.5 min-w-0 overflow-hidden">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white grid place-items-center font-bold text-[12px] flex-none shadow-xs">
            {currentUser?.email ? currentUser.email.charAt(0).toUpperCase() : 'A'}
          </div>
          <div className="flex flex-col leading-tight min-w-0 overflow-hidden">
            <span className="text-[12.5px] font-semibold text-text-1 truncate">
              {currentUser?.email ? currentUser.email.split('@')[0] : 'Đang xác thực...'}
            </span>
            <span className="text-[10.5px] text-text-3 capitalize truncate">
              {currentUser?.role || 'Đang tải'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-none ml-1">
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Tối'}
            aria-label="Đổi giao diện Sáng / Tối"
            className="grid h-8 w-8 place-items-center rounded-lg text-text-3 hover:text-text-1 hover:bg-surface transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-verity cursor-pointer"
          >
            {theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5 text-gold-ink" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-text-3" />
            )}
          </button>
          <button
            type="button"
            onClick={() => void onLogout()}
            title="Đăng xuất"
            aria-label="Đăng xuất"
            className="grid h-8 w-8 place-items-center rounded-lg text-text-3 hover:text-bad hover:bg-bad-soft transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-verity cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
