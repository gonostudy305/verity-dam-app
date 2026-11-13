import type { ReviewQueueItem } from '@/types/media';
import type { BatchGroup } from '@/hooks/useBatchGroups';

export interface ReviewGridGroup {
  key: string;
  label: string;
  itemIds: string[];
  /** Singletons stay visually flat to avoid inventing a group frame. */
  isVisualGroup: boolean;
}

/** Converts the legacy index-oriented batch grouping to the Grid's ID contract. */
export function mapBatchGroupsForGrid(
  queue: ReviewQueueItem[],
  batchGroups: BatchGroup[]
): ReviewGridGroup[] {
  const availableIds = new Set(queue.map((item) => item.id));
  return batchGroups.map((group) => {
    const itemIds = group.items.map((item) => item.id).filter((id) => availableIds.has(id));
    return {
      key: group.key,
      label: group.label,
      itemIds,
      isVisualGroup: itemIds.length > 1,
    };
  }).filter((group) => group.itemIds.length > 0);
}
