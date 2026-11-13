import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';

import {
  VALID_REPORT_REASONS,
  VALID_REPORT_STATUSES,
  createAssetReports,
  transitionAssetReports,
} from './asset-reports';
import { ApiError } from './http';

test('VALID_REPORT_REASONS contains exactly 4 canonical reasons', () => {
  assert.deepEqual(Array.from(VALID_REPORT_REASONS), [
    'wrong_sku',
    'wrong_recognition',
    'wrong_url',
    'other',
  ]);
});

test('VALID_REPORT_STATUSES contains the 4 lifecycle statuses', () => {
  assert.deepEqual(Array.from(VALID_REPORT_STATUSES), [
    'open',
    'in_review',
    'resolved',
    'dismissed',
  ]);
});

test('createAssetReports: rejects invalid reason', async () => {
  const dummyClient = {} as PoolClient;
  await assert.rejects(
    () =>
      createAssetReports(dummyClient, {
        mediaAssetIds: [crypto.randomUUID()],
        reportedBy: crypto.randomUUID(),
        reportReason: 'invalid_reason_here',
      }),
    (err: unknown) => {
      assert(err instanceof ApiError);
      assert.equal(err.code, 'INVALID_REPORT_REASON');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('createAssetReports: rejects reason other without a non-empty note', async () => {
  const dummyClient = {} as PoolClient;
  await assert.rejects(
    () =>
      createAssetReports(dummyClient, {
        mediaAssetIds: [crypto.randomUUID()],
        reportedBy: crypto.randomUUID(),
        reportReason: 'other',
        reportNote: '   ',
      }),
    (err: unknown) => {
      assert(err instanceof ApiError);
      assert.equal(err.code, 'NOTE_REQUIRED_FOR_OTHER');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('createAssetReports: rejects empty or non-uuid asset ids', async () => {
  const dummyClient = {} as PoolClient;
  await assert.rejects(
    () =>
      createAssetReports(dummyClient, {
        mediaAssetIds: ['not-a-uuid', 'also-invalid'],
        reportedBy: crypto.randomUUID(),
        reportReason: 'wrong_sku',
      }),
    (err: unknown) => {
      assert(err instanceof ApiError);
      assert.equal(err.code, 'NO_VALID_ASSET_IDS');
      return true;
    }
  );
});

test('createAssetReports: creates reports and audit events with valid data', async () => {
  const id1 = crypto.randomUUID();
  const id2 = crypto.randomUUID();
  const userId = crypto.randomUUID();

  const executedQueries: { sql: string; params: unknown[] }[] = [];
  const mockClient = {
    async query(sql: string, params: unknown[]) {
      executedQueries.push({ sql, params });
      if (sql.includes('INSERT INTO public.asset_reports')) {
        return {
          rows: [
            { id: 'rep-01', media_asset_id: id1 },
            { id: 'rep-02', media_asset_id: id2 },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const result = await createAssetReports(mockClient, {
    mediaAssetIds: [id1, id2, id1], // duplicate, should be deduplicated
    reportedBy: userId,
    reportReason: 'wrong_recognition',
    reportNote: 'AI nhận diện sai sản phẩm',
  });

  assert.equal(result.count, 2);
  assert.deepEqual(result.reportIds, ['rep-01', 'rep-02']);
  assert.equal(executedQueries.length, 2);
  assert(executedQueries[0].sql.includes('INSERT INTO public.asset_reports'));
  assert(executedQueries[1].sql.includes('INSERT INTO public.asset_report_events'));
  // verify params
  assert.deepEqual(executedQueries[0].params[0], [id1, id2]);
  assert.equal(executedQueries[0].params[2], 'wrong_recognition');
  assert.equal(executedQueries[0].params[3], 'AI nhận diện sai sản phẩm');
});

test('transitionAssetReports: rejects invalid status', async () => {
  const dummyClient = {} as PoolClient;
  await assert.rejects(
    () =>
      transitionAssetReports(dummyClient, {
        reportIds: [crypto.randomUUID()],
        nextStatus: 'unknown_status' as any,
        actorId: crypto.randomUUID(),
      }),
    (err: unknown) => {
      assert(err instanceof ApiError);
      assert.equal(err.code, 'INVALID_STATUS');
      return true;
    }
  );
});

test('transitionAssetReports: transitions reports and records audit trail', async () => {
  const rep1 = crypto.randomUUID();
  const rep2 = crypto.randomUUID();
  const userId = crypto.randomUUID();

  const executedQueries: { sql: string; params?: unknown[] }[] = [];
  const mockClient = {
    async query(sql: string, params?: unknown[]) {
      executedQueries.push({ sql, params });
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [
            { id: rep1, status: 'open' },
            { id: rep2, status: 'open' },
          ],
        };
      }
      if (sql.includes('UPDATE public.asset_reports')) {
        return { rowCount: 2 };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const result = await transitionAssetReports(mockClient, {
    reportIds: [rep1, rep2],
    nextStatus: 'resolved',
    actorId: userId,
    resolutionNote: 'Đã sửa SKU chuẩn xác',
  });

  assert.equal(result.updatedCount, 2);
  // 1 select for update + 1 update + 2 event inserts
  assert.equal(executedQueries.length, 4);
  assert(executedQueries[0].sql.includes('FOR UPDATE'));
  assert(executedQueries[1].sql.includes('UPDATE public.asset_reports'));
  assert(executedQueries[2].sql.includes('INSERT INTO public.asset_report_events'));
  assert(executedQueries[3].sql.includes('INSERT INTO public.asset_report_events'));
});
