'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewQueueItem } from '@/types/media';

export type SelectionMode = 'none' | 'single' | 'multi';

export interface BatchSelectionState {
  selectedIds: Set<string>;
  referenceId: string | null;
  lastAnchorId: string | null;
}

export interface UseBatchSelectionReturn {
  selectedIds: Set<string>;
  referenceId: string | null;
  selectionMode: SelectionMode;
  /** Always follows the current queue order, never insertion order of a Set. */
  selectedItems: ReviewQueueItem[];
  selectBatchGroup: (ids: string[], defaultReferenceId?: string) => void;
  toggleId: (id: string) => void;
  selectRange: (targetId: string) => void;
  setReferenceId: (id: string) => void;
  clearSelection: () => void;
  /** Selects loaded queue entries only; it never represents an unloaded cursor page. */
  selectAll: (ids?: string[]) => void;
}

export function emptyBatchSelection(): BatchSelectionState {
  return { selectedIds: new Set(), referenceId: null, lastAnchorId: null };
}

function firstSelectedQueueId(selectedIds: Set<string>, queue: ReviewQueueItem[]): string | null {
  return queue.find((item) => selectedIds.has(item.id))?.id ?? null;
}

function stateEquals(left: BatchSelectionState, right: BatchSelectionState): boolean {
  return left.referenceId === right.referenceId
    && left.lastAnchorId === right.lastAnchorId
    && left.selectedIds.size === right.selectedIds.size
    && Array.from(left.selectedIds).every((id) => right.selectedIds.has(id));
}

/**
 * Reconciles client-only selection state against the queue currently rendered.
 * A review decision removes rows from the queue, so IDs (not positions) are the
 * only safe selection key. Exported for deterministic tests of the same logic
 * used by the hook.
 */
export function reconcileBatchSelection(
  state: BatchSelectionState,
  queue: ReviewQueueItem[]
): BatchSelectionState {
  const availableIds = new Set(queue.map((item) => item.id));
  const selectedIds = new Set(Array.from(state.selectedIds).filter((id) => availableIds.has(id)));
  const referenceId = state.referenceId && selectedIds.has(state.referenceId)
    ? state.referenceId
    : firstSelectedQueueId(selectedIds, queue);
  const lastAnchorId = state.lastAnchorId && availableIds.has(state.lastAnchorId)
    ? state.lastAnchorId
    : null;

  return { selectedIds, referenceId, lastAnchorId };
}

export function selectionModeFor(selectedIds: Set<string>): SelectionMode {
  if (selectedIds.size === 0) return 'none';
  return selectedIds.size === 1 ? 'single' : 'multi';
}

export function toggleBatchSelection(
  state: BatchSelectionState,
  id: string,
  queue: ReviewQueueItem[]
): BatchSelectionState {
  const current = reconcileBatchSelection(state, queue);
  if (!queue.some((item) => item.id === id)) return current;

  const selectedIds = new Set(current.selectedIds);
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);

  return reconcileBatchSelection({
    selectedIds,
    referenceId: current.referenceId === id && !selectedIds.has(id)
      ? null
      : current.referenceId ?? id,
    lastAnchorId: id,
  }, queue);
}

export function selectBatchSelectionRange(
  state: BatchSelectionState,
  targetId: string,
  queue: ReviewQueueItem[]
): BatchSelectionState {
  const current = reconcileBatchSelection(state, queue);
  const targetIndex = queue.findIndex((item) => item.id === targetId);
  if (targetIndex === -1) return current;

  const anchorIndex = current.lastAnchorId
    ? queue.findIndex((item) => item.id === current.lastAnchorId)
    : targetIndex;
  const startIndex = anchorIndex === -1 ? targetIndex : anchorIndex;
  const [from, to] = [Math.min(startIndex, targetIndex), Math.max(startIndex, targetIndex)];
  const selectedIds = new Set(current.selectedIds);
  for (let index = from; index <= to; index += 1) selectedIds.add(queue[index].id);

  return reconcileBatchSelection({
    selectedIds,
    referenceId: current.referenceId,
    lastAnchorId: current.lastAnchorId ?? targetId,
  }, queue);
}

export function selectAllBatchSelection(
  state: BatchSelectionState,
  queue: ReviewQueueItem[],
  ids?: string[]
): BatchSelectionState {
  const availableIds = new Set(queue.map((item) => item.id));
  const selectedIds = new Set((ids ?? queue.map((item) => item.id)).filter((id) => availableIds.has(id)));
  return reconcileBatchSelection({
    selectedIds,
    referenceId: firstSelectedQueueId(selectedIds, queue),
    lastAnchorId: queue.filter((item) => selectedIds.has(item.id)).at(-1)?.id ?? null,
  }, queue);
}

export function useBatchSelection(queue: ReviewQueueItem[]): UseBatchSelectionReturn {
  const [rawSelection, setRawSelection] = useState<BatchSelectionState>(emptyBatchSelection);
  const selection = useMemo(
    () => reconcileBatchSelection(rawSelection, queue),
    [queue, rawSelection]
  );

  // Return a safe state in the render in which the queue changes, then persist
  // that state for later interactions. This prevents children ever reading a
  // removed ID while React schedules the effect.
  useEffect(() => {
    if (!stateEquals(rawSelection, selection)) setRawSelection(selection);
  }, [rawSelection, selection]);

  const selectedItems = useMemo(
    () => queue.filter((item) => selection.selectedIds.has(item.id)),
    [queue, selection.selectedIds]
  );
  const selectionMode = selectionModeFor(selection.selectedIds);

  const update = useCallback((operation: (state: BatchSelectionState) => BatchSelectionState) => {
    setRawSelection((previous) => reconcileBatchSelection(operation(previous), queue));
  }, [queue]);

  const selectBatchGroup = useCallback((ids: string[], defaultReferenceId?: string) => {
    update(() => {
      const availableIds = new Set(queue.map((item) => item.id));
      const selectedIds = new Set(ids.filter((id) => availableIds.has(id)));
      const referenceId = defaultReferenceId && selectedIds.has(defaultReferenceId)
        ? defaultReferenceId
        : firstSelectedQueueId(selectedIds, queue);
      return {
        selectedIds,
        referenceId,
        lastAnchorId: queue.filter((item) => selectedIds.has(item.id)).at(-1)?.id ?? null,
      };
    });
  }, [queue, update]);

  const toggleId = useCallback((id: string) => {
    update((previous) => toggleBatchSelection(previous, id, queue));
  }, [queue, update]);

  const selectRange = useCallback((targetId: string) => {
    update((previous) => selectBatchSelectionRange(previous, targetId, queue));
  }, [queue, update]);

  const setReferenceId = useCallback((id: string) => {
    update((previous) => {
      const current = reconcileBatchSelection(previous, queue);
      return current.selectedIds.has(id) ? { ...current, referenceId: id } : current;
    });
  }, [queue, update]);

  const clearSelection = useCallback(() => {
    setRawSelection(emptyBatchSelection());
  }, []);

  const selectAll = useCallback((ids?: string[]) => {
    update((previous) => selectAllBatchSelection(previous, queue, ids));
  }, [queue, update]);

  return {
    selectedIds: selection.selectedIds,
    referenceId: selection.referenceId,
    selectionMode,
    selectedItems,
    selectBatchGroup,
    toggleId,
    selectRange,
    setReferenceId,
    clearSelection,
    selectAll,
  };
}
