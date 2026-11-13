import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_UPLOAD_CONTEXT } from '@/config/upload-context';
import { bustUploadContextConfigCache, getUploadContextConfig } from './upload-context-config';

// getUploadContextConfig talks to Postgres; these tests exercise only the
// DB-unavailable fallback path (no DATABASE_URL in the test environment),
// mirroring search-config.test.ts's coverage of loadSearchConfig's fallback.

test('DEFAULT_UPLOAD_CONTEXT has the current quick presets and tag groups', () => {
  assert.equal(DEFAULT_UPLOAD_CONTEXT.quickPresets.length, 3);
  assert.equal(DEFAULT_UPLOAD_CONTEXT.tagGroups.length, 4);
  assert.deepEqual(
    DEFAULT_UPLOAD_CONTEXT.tagGroups.map((g) => g.name),
    ['Loại hình', 'Không gian', 'Ngành hàng & Dòng SP', 'Tiến độ']
  );
});

test('getUploadContextConfig falls back to defaults when DB is unavailable', async () => {
  bustUploadContextConfigCache();
  const config = await getUploadContextConfig();
  assert.deepEqual(config.quickPresets, DEFAULT_UPLOAD_CONTEXT.quickPresets);
  assert.deepEqual(config.tagGroups, DEFAULT_UPLOAD_CONTEXT.tagGroups);
});

test('bustUploadContextConfigCache resets cached state without error', () => {
  assert.doesNotThrow(() => {
    bustUploadContextConfigCache();
  });
});
