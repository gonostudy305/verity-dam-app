'use client';

import { Suspense } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DuplicatesView } from '@/components/duplicates/DuplicatesView';

export default function DuplicatesPage() {
  return (
    <AppShell title="Ảnh trùng" subtitle="So sánh và xử lý an toàn từng nhóm ảnh">
      <Suspense fallback={<div className="grid min-h-48 place-items-center text-[13px] text-text-3">Đang tải nhóm ảnh…</div>}>
        <DuplicatesView />
      </Suspense>
    </AppShell>
  );
}
