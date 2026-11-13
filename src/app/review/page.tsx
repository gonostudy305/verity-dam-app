'use client';

import React, { Suspense, useCallback, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ReviewView } from '@/components/review/ReviewView';

export default function ReviewPage() {
  const [queueCount, setQueueCount] = useState(0);
  const handleQueueUpdate = useCallback((count: number) => setQueueCount(count), []);

  return (
    <AppShell
      title="Hàng chờ duyệt"
      hideTitleOnMobile
      queueCount={queueCount}
      className="min-h-0 !overflow-hidden"
    >
      <Suspense fallback={<div className="h-full grid place-items-center text-[13px] text-text-3">Đang tải hàng chờ duyệt…</div>}>
        <ReviewView onQueueUpdate={handleQueueUpdate} />
      </Suspense>
    </AppShell>
  );
}
