import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

const enabled = process.env.VERITY_REVIEW_SCHEMA_TEST === '1';

// EXPLAIN plans the actual UPDATE without executing it or its triggers. This
// catches route/schema drift while leaving the selected database unchanged.
test('review decision updates are compatible with the PostgreSQL schema', {
  skip: enabled ? false : 'Set VERITY_REVIEW_SCHEMA_TEST=1 and DATABASE_URL to run the read-only schema check.',
}, async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('begin read only');
    const id = '00000000-0000-4000-8000-000000000001';
    for (const [route, target] of [
      ['src/app/api/review-queue/[id]/decision/route.ts', id],
      ['src/app/api/review-queue/batch-decision/route.ts', [id]],
    ] as const) {
      const source = readFileSync(resolve(route), 'utf8');
      const match = source.match(/`(update public\.media_assets a set[\s\S]*?)`/i);
      assert.ok(match, `Expected media_assets update in ${route}`);
      await client.query(`explain ${match[1]}`, [target, '{}', 'approved', false, null]);
    }
    await client.query('rollback');
  } finally {
    await client.end();
  }
});
