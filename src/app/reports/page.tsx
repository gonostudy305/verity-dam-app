'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ReportsView } from '@/components/reports/ReportsView';

export default function ReportsPage() {
  return (
    <AppShell
      title="Báo lỗi ảnh"
      subtitle="Theo dõi và xử lý các vấn đề metadata, SKU hoặc nhận diện"
    >
      <ReportsView />
    </AppShell>
  );
}
