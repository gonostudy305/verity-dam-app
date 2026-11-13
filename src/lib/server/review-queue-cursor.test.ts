import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeReviewQueueCursor, encodeReviewQueueCursor } from './review-queue-cursor';

test('review queue cursor round-trips stable ordering keys', () => {
  const cursor = {
    createdAt: '2026-09-11T10:20:30.000Z',
    id: '123e4567-e89b-12d3-a456-426614174000',
  };
  assert.deepEqual(decodeReviewQueueCursor(encodeReviewQueueCursor(cursor)), cursor);
});

test('review queue cursor rejects malformed or unsafe values', () => {
  assert.equal(decodeReviewQueueCursor('not-a-cursor'), null);
  assert.equal(decodeReviewQueueCursor(Buffer.from(JSON.stringify({ createdAt: 'yesterday', id: 'not-uuid' })).toString('base64url')), null);
  assert.equal(decodeReviewQueueCursor(undefined), null);
});

test('review queue cursor normalizes legacy Date.toString() strings to ISO-8601', () => {
  const legacyCursor = {
    createdAt: 'Thu Sep 10 2026 05:16:11 GMT+0000 (Coordinated Universal Time)',
    id: '123e4567-e89b-12d3-a456-426614174000',
  };
  const rawBase64 = Buffer.from(JSON.stringify(legacyCursor)).toString('base64url');
  const decoded = decodeReviewQueueCursor(rawBase64);
  assert.notEqual(decoded, null);
  assert.equal(decoded?.id, legacyCursor.id);
  assert.equal(decoded?.createdAt, '2026-09-10T05:16:11.000Z');
});
