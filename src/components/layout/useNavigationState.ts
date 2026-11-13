'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { apiRequest } from '@/lib/client/api';
import type { NavigationUser } from './navigation';

interface SessionResponse {
  authenticated: boolean;
  user: NavigationUser | null;
}

interface QueueResponse {
  total: number;
}

interface DuplicateResponse {
  data?: { total?: number; attention_count?: number };
  total?: number;
}

interface ReportResponse {
  total: number;
}

interface FeaturesResponse {
  product_intakes?: boolean;
}

// Every page renders its own AppShell, so the shell remounts on each client
// navigation. Keep the last known values at module scope so the remounted
// sidebar renders immediately instead of flashing an empty/unauthenticated
// state while the requests below refresh them.
const navigationCache: {
  user: NavigationUser | null;
  queueCount: number | null;
  duplicateCount: number | null;
  reportCount: number | null;
  productIntakesEnabled: boolean | null;
} = { user: null, queueCount: null, duplicateCount: null, reportCount: null, productIntakesEnabled: null };

/** Forget the cached session/counts, e.g. on logout so the next user starts clean. */
export function resetNavigationCache(): void {
  navigationCache.user = null;
  navigationCache.queueCount = null;
  navigationCache.duplicateCount = null;
  navigationCache.reportCount = null;
}

export function useNavigationState(queueCount?: number, duplicateCount?: number, reportCount?: number): {
  currentUser: NavigationUser | null;
  effectiveQueueCount: number;
  effectiveDuplicateCount: number;
  effectiveReportCount: number;
  productIntakesEnabled: boolean;
} {
  const pathname = usePathname();
  const [currentUser, setCurrentUser] = useState<NavigationUser | null>(navigationCache.user);
  const [liveQueueCount, setLiveQueueCount] = useState<number | null>(navigationCache.queueCount);
  const [liveDuplicateCount, setLiveDuplicateCount] = useState<number | null>(navigationCache.duplicateCount);
  const [liveReportCount, setLiveReportCount] = useState<number | null>(navigationCache.reportCount);
  const [productIntakesEnabled, setProductIntakesEnabled] = useState<boolean | null>(navigationCache.productIntakesEnabled);

  useEffect(() => {
    let active = true;
    apiRequest<SessionResponse>('/api/auth/session')
      .then((response) => {
        if (!active) return;
        if (response.authenticated && response.user) {
          navigationCache.user = response.user;
          setCurrentUser(response.user);
        } else if (pathname !== '/login') {
          navigationCache.user = null;
          window.location.href = `/login?returnUrl=${encodeURIComponent(pathname || '/library')}`;
        }
      })
      .catch(() => {
        if (active && pathname !== '/login') {
          navigationCache.user = null;
          window.location.href = `/login?returnUrl=${encodeURIComponent(pathname || '/library')}`;
        }
      });
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (navigationCache.productIntakesEnabled !== null) return;
    let active = true;
    apiRequest<FeaturesResponse>('/api/features')
      .then((response) => {
        const enabled = response?.product_intakes === true;
        navigationCache.productIntakesEnabled = enabled;
        if (active) setProductIntakesEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<QueueResponse>('/api/review-queue?limit=1')
      .then((response) => {
        if (active && typeof response?.total === 'number') {
          navigationCache.queueCount = response.total;
          setLiveQueueCount(response.total);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    let active = true;
    apiRequest<DuplicateResponse>('/api/dedup/clusters?limit=1')
      .then((response) => {
        const total = response?.data?.attention_count ?? response?.total;
        if (active && typeof total === 'number') {
          navigationCache.duplicateCount = total;
          setLiveDuplicateCount(total);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [pathname]);

  useEffect(() => {
    let active = true;
    apiRequest<ReportResponse>('/api/asset-reports?status=open&page_size=1')
      .then((response) => {
        if (active && typeof response?.total === 'number') {
          navigationCache.reportCount = response.total;
          setLiveReportCount(response.total);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [pathname]);

  return {
    currentUser,
    effectiveQueueCount: queueCount !== undefined ? queueCount : (liveQueueCount ?? 0),
    effectiveDuplicateCount: duplicateCount !== undefined ? duplicateCount : (liveDuplicateCount ?? 0),
    effectiveReportCount: reportCount !== undefined ? reportCount : (liveReportCount ?? 0),
    // Unknown until /api/features answers: hide the link rather than show a
    // destination that may 404.
    productIntakesEnabled: productIntakesEnabled === true,
  };
}
