import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ProductIntakeWorkspace } from '@/components/product-intakes/ProductIntakeWorkspace';

export default async function ProductIntakeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell title="Hồ sơ sản phẩm" hideTitleOnMobile>
      <ProductIntakeWorkspace intakeId={id} />
    </AppShell>
  );
}
