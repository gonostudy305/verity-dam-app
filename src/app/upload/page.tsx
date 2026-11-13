'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { UploadView } from '@/components/upload/UploadView';

export default function UploadPage() {
  return (
    <AppShell
      title="Upload"
      hideTitle
    >
      <UploadView />
    </AppShell>
  );
}
