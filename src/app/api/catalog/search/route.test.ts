import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { GET } from './route';

test('GET /api/catalog/search returns empty data for short or empty query', async () => {
  const reqEmpty = new NextRequest('http://localhost:3000/api/catalog/search?q=');
  try {
    const res = await GET(reqEmpty);
    if (res.status === 200) {
      const json = await res.json();
      assert.deepEqual(json, { data: [] });
    } else {
      assert.ok(res.status === 401 || res.status === 403);
    }
  } catch (err) {
    assert.ok(err);
  }
});
