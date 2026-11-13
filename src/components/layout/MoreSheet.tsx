'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, LogOut } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/common/ThemeToggle';
import { ResponsiveDialogClose, ResponsiveDialogSheet, TouchIconButton } from '@/components/common/interaction-primitives';
import { canNavigate, isNavigationItemActive, SECONDARY_NAV_ITEMS, NavigationUser } from './navigation';

interface MoreSheetProps {
  currentUser: NavigationUser | null;
  onLogout: () => void;
}

export function MoreSheet({ currentUser, onLogout }: MoreSheetProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const handleViewportChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setOpen(false);
    };

    if (!mediaQuery.matches) setOpen(false);
    mediaQuery.addEventListener?.('change', handleViewportChange);
    return () => mediaQuery.removeEventListener?.('change', handleViewportChange);
  }, []);

  return (
    <ResponsiveDialogSheet
      open={open}
      onOpenChange={setOpen}
      title="Thêm"
      description="Các khu vực phụ, tài khoản và tuỳ chọn giao diện."
      trigger={
        <TouchIconButton
          label="Mở thêm điều hướng"
          className="flex h-auto min-w-0 flex-1 flex-col gap-0.5 rounded-xl px-1 py-1 text-[10.5px] font-semibold text-text-2 hover:text-text-1"
        >
          <span className="grid h-7 w-12 place-items-center rounded-full">
            <Menu aria-hidden="true" className="h-[19px] w-[19px]" />
          </span>
          <span>Thêm</span>
        </TouchIconButton>
      }
      contentClassName="space-y-2"
    >
      <div className="grid gap-1.5">
        {SECONDARY_NAV_ITEMS.filter((item) => canNavigate(item, currentUser)).map((item) => {
          const Icon = item.icon;
          return (
            <ResponsiveDialogClose key={item.href}>
              <Link
                href={item.href}
                aria-current={isNavigationItemActive(pathname, item.href) ? 'page' : undefined}
                className={cn(
                  'flex min-h-12 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
                  isNavigationItemActive(pathname, item.href) ? 'bg-verity-soft text-verity-fg' : 'text-text-2 hover:text-text-1'
                )}
              >
                <Icon aria-hidden="true" className="h-[18px] w-[18px] text-text-3" />
                <span>{item.label}</span>
              </Link>
            </ResponsiveDialogClose>
          );
        })}
      </div>

      <div className="border-t border-border-subtle pt-2">
        <ThemeToggle className="h-12 w-full justify-start rounded-xl px-3" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/60 p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-9 w-9 flex-none place-items-center rounded-full bg-verity text-sm font-bold text-white">
            {currentUser?.email ? currentUser.email.charAt(0).toUpperCase() : 'A'}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-semibold text-text-1">
              {currentUser?.email ? currentUser.email.split('@')[0] : 'Tài khoản'}
            </p>
            <p className="truncate text-[11px] capitalize text-text-3">{currentUser?.role || 'Chưa xác thực'}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className={cn('grid h-11 w-11 flex-none place-items-center rounded-xl text-text-3 transition-colors hover:bg-bad-soft hover:text-bad focus:outline-none focus-visible:ring-2 focus-visible:ring-verity')}
          aria-label="Đăng xuất"
          title="Đăng xuất"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
    </ResponsiveDialogSheet>
  );
}
