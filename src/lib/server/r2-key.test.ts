import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidStorageKey } from './r2';

test('isValidStorageKey: accepts standard R2 storage paths', () => {
  assert.equal(
    isValidStorageKey('1717f588-2aeb-4bcb-9813-519c1e8c3090/2026/08/sample-photo.jpg'),
    true
  );
  assert.equal(
    isValidStorageKey('user-id/2026/09/uuid-filename.webp'),
    true
  );
});

test('isValidStorageKey: accepts filenames with consecutive or multiple dots in stem', () => {
  assert.equal(
    isValidStorageKey(
      '1717f588-2aeb-4bcb-9813-519c1e8c3090/2026/08/bcec4af6-f3b9-4053-901c-a80ba40eedab-https-_www.eden.com_ar_product_dl05_63211_srsltid_AfmBOoqDDoxSY1W6eX-EsWt-4H4Nq3vohTH2jrteR23yEOwhDNkncn0v..webp'
    ),
    true
  );
  assert.equal(isValidStorageKey('folder/file..name..jpg'), true);
  assert.equal(isValidStorageKey('folder/file.min.js.webp'), true);
});

test('isValidStorageKey: rejects actual path traversal attempts', () => {
  assert.equal(isValidStorageKey('../secret.jpg'), false);
  assert.equal(isValidStorageKey('folder/../secret.jpg'), false);
  assert.equal(isValidStorageKey('folder/sub/..'), false);
  assert.equal(isValidStorageKey('..'), false);
  assert.equal(isValidStorageKey('folder/./file.jpg'), false);
  assert.equal(isValidStorageKey('folder//file.jpg'), false);
});

test('isValidStorageKey: rejects absolute paths and null bytes', () => {
  assert.equal(isValidStorageKey('/etc/passwd'), false);
  assert.equal(isValidStorageKey('/folder/file.jpg'), false);
  assert.equal(isValidStorageKey('folder/file\0.jpg'), false);
});

test('isValidStorageKey: rejects empty or whitespace-only keys', () => {
  assert.equal(isValidStorageKey(''), false);
  assert.equal(isValidStorageKey('   '), false);
  assert.equal(isValidStorageKey(null as unknown as string), false);
  assert.equal(isValidStorageKey(undefined as unknown as string), false);
});
