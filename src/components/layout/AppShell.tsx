'use client';

import React from 'react';
import { Sidebar } from './Sidebar';
import { NavigationRail } from './NavigationRail';
import { MobileBottomNav } from './MobileBottomNav';
import { Topbar } from './Topbar';
import { cn } from '@/lib/utils';
import { TaxonomyProvider } from '@/hooks/useTaxonomy';
import { resetNavigationCache, useNavigationState } from './useNavigationState';
import { apiRequest } from '@/lib/client/api';
import { useRouter } from 'next/navigation';

interface AppShellProps {
  title: string;
  subtitle?: string;
  hideTitleOnMobile?: boolean;
  hideTitle?: boolean;
  queueCount?: number;
  duplicateCount?: number;
  reportCount?: number;
  onSelectDemoState?: (stateName: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function AppShell({
  title,
  subtitle,
  hideTitleOnMobile,
  hideTitle,
  queueCount,
  duplicateCount,
  reportCount,
  onSelectDemoState,
  children,
  className,
}: AppShellProps) {
  const router = useRouter();
  const { currentUser, effectiveQueueCount, effectiveDuplicateCount, effectiveReportCount, productIntakesEnabled } = useNavigationState(queueCount, duplicateCount, reportCount);

  const handleLogout = async () => {
    const accountLabel = currentUser?.email ? ` (${currentUser.email})` : '';
    if (!window.confirm(`Bạn có chắc muốn đăng xuất khỏi VerityDAM${accountLabel} không?`)) return;

    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } finally {
      resetNavigationCache();
      router.push('/login');
      router.refresh();
    }
  };

  return (
    <div data-testid="app-shell" className="app-shell flex h-[100svh] h-dvh w-full overflow-hidden bg-paper text-text-1">
      <a href="#main-content" className="skip-link">
        Bỏ qua điều hướng, đến nội dung chính
      </a>

      {/* One navigation model, presented as an expanded sidebar, compact rail,
          or phone bottom bar. CSS switches presentation without remounting the
          page content or forking business state. */}
      <Sidebar queueCount={effectiveQueueCount} duplicateCount={effectiveDuplicateCount} reportCount={effectiveReportCount} productIntakesEnabled={productIntakesEnabled} currentUser={currentUser} onLogout={handleLogout} />
      <NavigationRail queueCount={effectiveQueueCount} duplicateCount={effectiveDuplicateCount} reportCount={effectiveReportCount} productIntakesEnabled={productIntakesEnabled} currentUser={currentUser} onLogout={handleLogout} />
      <MobileBottomNav queueCount={effectiveQueueCount} duplicateCount={effectiveDuplicateCount} reportCount={effectiveReportCount} productIntakesEnabled={productIntakesEnabled} currentUser={currentUser} onLogout={handleLogout} />

      {/* Main Content Area */}
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar
          title={title}
          subtitle={subtitle}
          hideTitleOnMobile={hideTitleOnMobile}
          hideTitle={hideTitle}
          onSelectDemoState={onSelectDemoState}
        />
        <main id="main-content" tabIndex={-1} data-testid="main-content" className={cn('app-main relative min-w-0 flex-1 overflow-y-auto', className)}>
          <TaxonomyProvider>{children}</TaxonomyProvider>
        </main>
      </div>
    </div>
  );
}
