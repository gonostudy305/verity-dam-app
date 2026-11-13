'use client';

import React from 'react';
import { MediaAsset } from '@/types/media';
import { JustifiedRowData } from '@/hooks/useJustifiedLayout';
import { MediaGridItem } from './MediaCard';

const FILL_STYLE: React.CSSProperties = { width: '100%', height: '100%' };

interface JustifiedRowProps {
  row: JustifiedRowData;
  selectedIds: string[];
  onToggleSelect: (id: string, e: React.MouseEvent) => void;
  onOpenDetail: (asset: MediaAsset) => void;
  density?: 'compact' | 'comfortable';
  gap?: number;
}

export function JustifiedRow({
  row,
  selectedIds,
  onToggleSelect,
  onOpenDetail,
  density = 'comfortable',
  gap = 12,
}: JustifiedRowProps) {
  return (
    <div
      className="flex flex-nowrap items-center w-full"
      style={{
        gap: `${gap}px`,
        height: `${row.height}px`,
      }}
    >
      {row.items.map(({ asset, width }) => (
        <div
          key={asset.id}
          className="relative flex-shrink-0 h-full overflow-hidden rounded-xl"
          style={{ width: `${width}px` }}
        >
          <MediaGridItem
            asset={asset}
            selected={selectedIds.includes(asset.id)}
            onToggleSelect={onToggleSelect}
            onOpenDetail={onOpenDetail}
            density={density}
            style={FILL_STYLE}
          />
        </div>
      ))}
    </div>
  );
}
