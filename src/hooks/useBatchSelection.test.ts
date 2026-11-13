import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewQueueItem } from '@/types/media';
import {
  emptyBatchSelection,
  reconcileBatchSelection,
  selectAllBatchSelection,
  selectBatchSelectionRange,
  selectionModeFor,
  toggleBatchSelection,
} from './useBatchSelection';

function item(id: string): ReviewQueueItem {
  return { id } as ReviewQueueItem;
}

const initialQueue = [item('a'), item('b'), item('c'), item('d')];

test('uses ID selection and preserves the remaining selected photos after a middle item is removed', () => {
  let selection = toggleBatchSelection(emptyBatchSelection(), 'a', initialQueue);
  selection = selectBatchSelectionRange(selection, 'd', initialQueue);
  const afterRemoval = reconcileBatchSelection(selection, [item('a'), item('c'), item('d')]);

  assert.deepEqual(Array.from(afterRemoval.selectedIds), ['a', 'c', 'd']);
  assert.equal(afterRemoval.referenceId, 'a');
});

test('falls back to the first remaining queue item when the reference is removed', () => {
  const selection = {
    selectedIds: new Set(['a', 'b', 'c']),
    referenceId: 'b',
    lastAnchorId: 'b',
  };
  const afterRemoval = reconcileBatchSelection(selection, [item('a'), item('c')]);

  assert.equal(afterRemoval.referenceId, 'a');
  assert.equal(afterRemoval.lastAnchorId, null);
});

test('keeps an existing range unchanged when a later cursor page is appended', () => {
  let selection = toggleBatchSelection(emptyBatchSelection(), 'b', initialQueue);
  selection = selectBatchSelectionRange(selection, 'c', initialQueue);
  const afterAppend = reconcileBatchSelection(selection, [...initialQueue, item('e'), item('f')]);

  assert.deepEqual(Array.from(afterAppend.selectedIds), ['b', 'c']);
  assert.equal(afterAppend.referenceId, 'b');
});

test('selectAll includes only loaded queue IDs, even when an external list includes unloaded IDs', () => {
  const selection = selectAllBatchSelection(emptyBatchSelection(), initialQueue, ['a', 'b', 'unloaded']);

  assert.deepEqual(Array.from(selection.selectedIds), ['a', 'b']);
  assert.equal(selection.referenceId, 'a');
});

test('derives explicit none, single, and multi selection modes', () => {
  assert.equal(selectionModeFor(new Set()), 'none');
  assert.equal(selectionModeFor(new Set(['a'])), 'single');
  assert.equal(selectionModeFor(new Set(['a', 'b'])), 'multi');
});
