'use client';

import React from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { ProductIntakeList } from '@/components/product-intakes/ProductIntakeList';

export default function ProductIntakesPage() {
  return (
    <AppShell title="Hồ sơ sản phẩm" hideTitleOnMobile>
      <ProductIntakeList />
    </AppShell>
  );
}
