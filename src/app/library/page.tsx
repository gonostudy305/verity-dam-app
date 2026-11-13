'use client';

import React, { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { LibraryView } from '@/components/library/LibraryView';

export default function LibraryPage() {
  return (
    <AppShell
      title="Thư viện"
      subtitle="Tài sản đã được duyệt"
    >
      <Suspense fallback={null}>
        <LibraryView />
      </Suspense>
    </AppShell>
  );
}
