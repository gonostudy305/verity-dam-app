import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/media/[id]/select/route';

test('POST /api/media/[id]/select rejects non-UUID id with 400 INVALID_ID', async () => {
  const req = new NextRequest('http://localhost:3000/api/media/not-a-uuid/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'Facebook' }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, 'INVALID_ID');
});

test('POST /api/media/[id]/select fails closed (401 or 503) on unauthenticated request', async () => {
  const req = new NextRequest('http://localhost:3000/api/media/a0000000-0000-4000-8000-000000000001/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'Facebook' }),
  });
  const res = await POST(req, { params: Promise.resolve({ id: 'a0000000-0000-4000-8000-000000000001' }) });
  assert.ok([401, 503].includes(res.status));
});
