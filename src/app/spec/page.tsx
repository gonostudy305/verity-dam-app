'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DesignSpecView } from '@/components/spec/DesignSpecView';

export default function SpecPage() {
  return (
    <AppShell
      title="Ghi chú thiết kế"
      subtitle="Component spec · Micro-interaction"
    >
      <DesignSpecView />
    </AppShell>
  );
}
