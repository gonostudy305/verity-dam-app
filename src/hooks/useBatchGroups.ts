'use client';

import { useMemo } from 'react';
import { ReviewQueueItem } from '@/types/media';

export interface BatchGroup {
  key: string;
  label: string;
  indices: number[];
  items: ReviewQueueItem[];
  suggestedSku?: string;
  suggestedSkuConfidence?: number;
  suggestedBrand?: string;
  suggestedCategory?: string;
  suggestedSpace?: string;
}

/**
 * Pure function to calculate batch groups from a review queue.
 * 3-tier grouping:
 * 1. Primary: origin_info.import_batch_id (GDrive / Zalo sync)
 * 2. Fallback: origin_info.batch_id (Web Upload)
 * 3. Fallback: consecutive items created within a 60-second time window
 */
export function calculateBatchGroups(queue: ReviewQueueItem[]): BatchGroup[] {
  if (!queue || queue.length === 0) return [];

  const groups: BatchGroup[] = [];
  const groupMap = new Map<string, BatchGroup>();

  let currentTimeWindowGroup: BatchGroup | null = null;
  let lastItemTime: number | null = null;

  queue.forEach((item, index) => {
    const origin = item.asset.origin_info || {};
    const importBatchId = origin.import_batch_id;
    const batchId = origin.batch_id;

    let key: string;
    let label: string;

    if (importBatchId) {
      key = `import:${importBatchId}`;
      const context = origin.batch_context || origin.project_name;
      label = context ? `Lô: ${context}` : `Lô ${importBatchId.slice(0, 16)}`;
      currentTimeWindowGroup = null;
    } else if (batchId) {
      key = `upload:${batchId}`;
      const name = origin.project_name || origin.batch_context;
      label = name ? `Lô: ${name}` : `Lô tải lên ${batchId.slice(0, 8)}`;
      currentTimeWindowGroup = null;
    } else {
      // Time-window grouping for items without explicit batch ID
      const itemTime = new Date(item.created_at || item.asset.created_at).getTime();
      const isCloseInTime = lastItemTime !== null && !isNaN(itemTime) && Math.abs(itemTime - lastItemTime) <= 60_000;

      if (isCloseInTime && currentTimeWindowGroup) {
        currentTimeWindowGroup.indices.push(index);
        currentTimeWindowGroup.items.push(item);
        lastItemTime = itemTime;
        return;
      } else {
        const timeStr = !isNaN(itemTime)
          ? new Date(itemTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
          : `#${index + 1}`;
        key = `time:${itemTime || index}`;
        label = `Nhóm ${timeStr}`;
        lastItemTime = itemTime;
      }
    }

    let existing = groupMap.get(key);
    if (!existing) {
      existing = {
        key,
        label,
        indices: [index],
        items: [item],
      };
      groupMap.set(key, existing);
      groups.push(existing);
      if (key.startsWith('time:')) {
        currentTimeWindowGroup = existing;
      }
    } else {
      existing.indices.push(index);
      existing.items.push(item);
    }
  });

  // Calculate suggested metadata per group
  for (const group of groups) {
    let bestSku: string | undefined;
    let highestSkuConf = -1;
    let foundBrand: string | undefined;
    let foundCategory: string | undefined;
    let foundSpace: string | undefined;

    for (const item of group.items) {
      const asset = item.asset;
      const skuCandidate = item.sku_match?.sku || asset.sku || item.metadata_draft?.sku;
      const rawConf = asset.ai_confidence?.sku ?? (item.sku_match?.similarity ? item.sku_match.similarity * 100 : 0);
      const conf = typeof rawConf === 'number' && Number.isFinite(rawConf) ? rawConf : 0;

      if (skuCandidate && conf > highestSkuConf) {
        bestSku = skuCandidate;
        highestSkuConf = conf;
      }

      if (!foundBrand && (asset.brand || item.metadata_draft?.brand)) {
        foundBrand = asset.brand || item.metadata_draft?.brand;
      }
      if (!foundCategory && (asset.category || item.metadata_draft?.category)) {
        foundCategory = asset.category || item.metadata_draft?.category;
      }
      if (!foundSpace && asset.space) {
        foundSpace = asset.space;
      }
    }

    if (bestSku) {
      group.suggestedSku = bestSku;
      group.suggestedSkuConfidence = Math.round(highestSkuConf);
    }
    if (foundBrand) group.suggestedBrand = foundBrand;
    if (foundCategory) group.suggestedCategory = foundCategory;
    if (foundSpace) group.suggestedSpace = foundSpace;
  }

  return groups;
}

export function useBatchGroups(queue: ReviewQueueItem[]): BatchGroup[] {
  return useMemo(() => calculateBatchGroups(queue), [queue]);
}
