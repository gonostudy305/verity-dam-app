import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeMediaCursor,
  encodeMediaCursor,
  requireWordPressSyncToken,
} from './wordpress';
import { ApiError } from './http';

test('encodeMediaCursor and decodeMediaCursor round-trip valid cursor', () => {
  const payload = {
    t: '2026-09-07T12:00:00.000Z',
    id: '11111111-2222-3333-4444-555555555555',
  };
  const encoded = encodeMediaCursor(payload);
  assert.equal(typeof encoded, 'string');
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.includes('+'), false);

  const decoded = decodeMediaCursor(encoded);
  assert.deepEqual(decoded, payload);
});

test('encodeMediaCursor and decodeMediaCursor preserve PostgreSQL microsecond precision', () => {
  const payload = {
    t: '2026-09-07T05:49:21.458087Z',
    id: 'd46d00f3-81bb-40f0-a910-49cc18374786',
  };
  const encoded = encodeMediaCursor(payload);
  const decoded = decodeMediaCursor(encoded);
  assert.equal(decoded.t, payload.t);
  assert.equal(decoded.id, payload.id);
});

test('decodeMediaCursor rejects corrupted or non-base64url payload', () => {
  assert.throws(() => decodeMediaCursor('not-valid-json!'), (err: any) => {
    return err instanceof ApiError && err.status === 400 && err.code === 'INVALID_CURSOR';
  });
});

test('decodeMediaCursor rejects invalid ISO timestamp', () => {
  const badTime = Buffer.from(
    JSON.stringify({ t: 'not-a-date', id: '11111111-2222-3333-4444-555555555555' })
  ).toString('base64url');

  assert.throws(() => decodeMediaCursor(badTime), (err: any) => {
    return err instanceof ApiError && err.status === 400 && err.code === 'INVALID_CURSOR';
  });

  // Non-strict formats like 'September 7, 2026' parse in Date.parse() but fail strict ISO regex
  const nonStrictTime = Buffer.from(
    JSON.stringify({ t: 'September 7, 2026', id: '11111111-2222-3333-4444-555555555555' })
  ).toString('base64url');

  assert.throws(() => decodeMediaCursor(nonStrictTime), (err: any) => {
    return err instanceof ApiError && err.status === 400 && err.code === 'INVALID_CURSOR';
  });
});

test('decodeMediaCursor rejects invalid UUID', () => {
  const badId = Buffer.from(
    JSON.stringify({ t: '2026-09-07T12:00:00.000Z', id: 'not-a-uuid' })
  ).toString('base64url');

  assert.throws(() => decodeMediaCursor(badId), (err: any) => {
    return err instanceof ApiError && err.status === 400 && err.code === 'INVALID_CURSOR';
  });
});

test('requireWordPressSyncToken validates token correctly', () => {
  const originalEnv = process.env.VERITY_WORDPRESS_SYNC_TOKEN;
  try {
    process.env.VERITY_WORDPRESS_SYNC_TOKEN = 'secret-token-that-is-at-least-32-chars-long';

    // Valid bearer token
    assert.doesNotThrow(() => {
      requireWordPressSyncToken('Bearer secret-token-that-is-at-least-32-chars-long');
    });

    // Wrong token
    assert.throws(() => {
      requireWordPressSyncToken('Bearer wrong-token-that-is-at-least-32-characters!');
    }, (err: any) => err instanceof ApiError && err.code === 'WORDPRESS_AUTHENTICATION_REQUIRED');

    // Missing header
    assert.throws(() => {
      requireWordPressSyncToken(null);
    }, (err: any) => err instanceof ApiError && err.code === 'WORDPRESS_AUTHENTICATION_REQUIRED');
  } finally {
    process.env.VERITY_WORDPRESS_SYNC_TOKEN = originalEnv;
  }
});
