import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '@/lib/server/http';
import { assertBatchResolutionAllowed, parseBatchResolveRequestBody, parseResolveRequestBody } from '@/lib/server/dedup-route-contracts';

function errorCode(callback: () => unknown) {
  try { callback(); } catch (error) { return error instanceof ApiError ? error.code : 'UNKNOWN'; }
  return 'NO_ERROR';
}

test('resolve route contract covers body, resolution, and keep-one validation', () => {
  assert.equal(errorCode(() => parseResolveRequestBody(null)), 'INVALID_BODY');
  assert.equal(errorCode(() => parseResolveRequestBody({ resolution: 'other' })), 'INVALID_RESOLUTION');
  assert.equal(errorCode(() => parseResolveRequestBody({ resolution: 'keep_one' })), 'INVALID_BODY');
  assert.equal(errorCode(() => parseResolveRequestBody({ resolution: 'keep_one', keep_asset_id: 'not-uuid', remove_asset_ids: ['not-uuid'] })), 'INVALID_BODY');
});

test('batch route contract rejects force-confirm, empty, over-cap, and malformed input', () => {
  assert.equal(errorCode(() => parseBatchResolveRequestBody({ cluster_ids: [], resolution: 'keep_all' })), 'NO_IDS');
  assert.equal(errorCode(() => parseBatchResolveRequestBody({ cluster_ids: Array.from({ length: 26 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`), resolution: 'keep_all' })), 'TOO_MANY_CLUSTERS');
  assert.equal(errorCode(() => parseBatchResolveRequestBody({ cluster_ids: ['bad'], resolution: 'keep_all' })), 'INVALID_BODY');
  assert.equal(errorCode(() => parseBatchResolveRequestBody({ cluster_ids: ['00000000-0000-4000-8000-000000000001'], resolution: 'keep_all', force_confirm: true })), 'INVALID_BODY');
});

test('batch resolution cannot infer deletions from a selected cluster', () => {
  assert.equal(errorCode(() => assertBatchResolutionAllowed('keep_one')), 'BULK_KEEP_ONE_DISABLED');
  assert.equal(errorCode(() => assertBatchResolutionAllowed('keep_all')), 'NO_ERROR');
});
