import { useMemo } from 'react';
import { MediaAsset } from '@/types/media';

export interface JustifiedItem {
  asset: MediaAsset;
  width: number;
  height: number;
  aspectRatio: number;
}

export interface JustifiedRowData {
  id: string;
  height: number;
  items: JustifiedItem[];
  isLastRow: boolean;
}

export interface UseJustifiedLayoutOptions {
  items: MediaAsset[];
  containerWidth: number;
  targetRowHeight?: number;
  gap?: number;
}

export function calculateJustifiedLayout({
  items,
  containerWidth,
  targetRowHeight = 260,
  gap = 12,
}: UseJustifiedLayoutOptions): JustifiedRowData[] {
  if (!containerWidth || containerWidth <= 0 || items.length === 0) {
    return [];
  }

  const rows: JustifiedRowData[] = [];
  let currentRowItems: { asset: MediaAsset; aspectRatio: number }[] = [];
  let currentRowAspectSum = 0;

  for (let i = 0; i < items.length; i++) {
    const asset = items[i];
    const w = asset.dimensions?.width || 0;
    const h = asset.dimensions?.height || 0;
    const aspectRatio = w > 0 && h > 0 ? w / h : 4 / 3;

    currentRowItems.push({ asset, aspectRatio });
    currentRowAspectSum += aspectRatio;

    const gapsTotal = (currentRowItems.length - 1) * gap;
    const availableWidth = containerWidth - gapsTotal;
    const calculatedHeight = availableWidth / currentRowAspectSum;

    // Close row when calculated height hits target height or last item
    if (calculatedHeight <= targetRowHeight || i === items.length - 1) {
      const isLastItem = i === items.length - 1;
      const isLastRow = isLastItem && calculatedHeight > targetRowHeight * 1.35;

      // Last row with too few items -> fixed target height (left-aligned)
      const rowHeight = isLastRow
        ? targetRowHeight
        : Math.max(120, Math.min(450, calculatedHeight));

      let currentX = 0;
      const rowJustifiedItems: JustifiedItem[] = currentRowItems.map((item, idx) => {
        let itemWidth: number;
        if (isLastRow) {
          itemWidth = Math.round(targetRowHeight * item.aspectRatio);
        } else {
          if (idx === currentRowItems.length - 1) {
            itemWidth = Math.max(1, containerWidth - gapsTotal - currentX);
          } else {
            itemWidth = Math.round(rowHeight * item.aspectRatio);
            currentX += itemWidth;
          }
        }
        return {
          asset: item.asset,
          width: itemWidth,
          height: Math.round(rowHeight),
          aspectRatio: item.aspectRatio,
        };
      });

      rows.push({
        id: `row-${rows.length}-${currentRowItems[0].asset.id}`,
        height: Math.round(rowHeight),
        items: rowJustifiedItems,
        isLastRow,
      });

      currentRowItems = [];
      currentRowAspectSum = 0;
    }
  }

  return rows;
}

export function useJustifiedLayout(options: UseJustifiedLayoutOptions): JustifiedRowData[] {
  return useMemo(
    () => calculateJustifiedLayout(options),
    [options.items, options.containerWidth, options.targetRowHeight, options.gap]
  );
}
