import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonArray, jsonObject } from './media-soft-delete';

test('soft-delete JSON helpers fail closed on malformed queue payloads', () => {
  assert.deepEqual(jsonArray('["a", "b"]'), ['a', 'b']);
  assert.deepEqual(jsonArray('{bad'), []);
  assert.deepEqual(jsonObject('{"phash":[]}'), { phash: [] });
  assert.deepEqual(jsonObject('[]'), {});
});
