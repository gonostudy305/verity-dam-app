import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationError } from '@/lib/media-api';
import {
  batchProgressPercent,
  buildBatchSummary,
  parseBatchId,
  shouldKeepPolling,
  type BatchSummary,
} from '@/lib/ingest-batch';

const ID = '3f1c2b7e-8a4d-4c1e-9b6a-0d5e7f9a1b2c';

function summary(patch: Partial<BatchSummary> = {}): BatchSummary {
  return {
    total: 0, queued: 0, processing: 0, ready: 0, failed: 0, blocked: 0,
    duplicates: 0, with_sku: 0, without_sku: 0, finished: false,
    ...patch,
  };
}

test('parseBatchId chấp nhận UUID và chuẩn hóa chữ thường', () => {
  assert.equal(parseBatchId(ID.toUpperCase()), ID);
  assert.equal(parseBatchId(`  ${ID} `), ID);
});

test('parseBatchId từ chối giá trị không phải UUID', () => {
  for (const bad of ['', 'abc', "1' or '1'='1", `${ID}x`, undefined, null, 42]) {
    assert.throws(() => parseBatchId(bad as unknown as string), ValidationError);
  }
});

test('buildBatchSummary rỗng -> toàn số 0, chưa finished', () => {
  assert.deepEqual(buildBatchSummary([]), summary());
});

test('buildBatchSummary cộng dồn theo trạng thái, trùng và SKU', () => {
  const result = buildBatchSummary([
    { ingest_status: 'ready', is_duplicate: false, has_sku: true, n: 10 },
    { ingest_status: 'ready', is_duplicate: true, has_sku: true, n: 2 },
    { ingest_status: 'queued', is_duplicate: false, has_sku: false, n: 3 },
    { ingest_status: 'processing', is_duplicate: false, has_sku: true, n: 1 },
    { ingest_status: 'failed', is_duplicate: false, has_sku: false, n: 4 },
  ]);
  assert.deepEqual(result, summary({
    total: 20, ready: 12, queued: 3, processing: 1, failed: 4,
    duplicates: 2, with_sku: 13, without_sku: 7, finished: false,
  }));
});

test('buildBatchSummary: finished khi không còn queued/processing', () => {
  const result = buildBatchSummary([
    { ingest_status: 'ready', is_duplicate: false, has_sku: true, n: 5 },
    { ingest_status: 'failed', is_duplicate: false, has_sku: true, n: 1 },
    { ingest_status: 'blocked', is_duplicate: false, has_sku: true, n: 1 },
  ]);
  assert.equal(result.finished, true);
  assert.equal(result.blocked, 1);
});

test('buildBatchSummary: trạng thái lạ không bị bỏ sót mà tính vào blocked', () => {
  const result = buildBatchSummary([{ ingest_status: 'weird', is_duplicate: false, has_sku: true, n: 2 }]);
  assert.equal(result.total, 2);
  assert.equal(result.blocked, 2);
  assert.equal(result.finished, true);
});

test('buildBatchSummary ép n về số nguyên không âm (pg trả bigint dạng chuỗi)', () => {
  const result = buildBatchSummary([
    { ingest_status: 'ready', is_duplicate: false, has_sku: true, n: '7' as unknown as number },
  ]);
  assert.equal(result.ready, 7);
  assert.equal(result.total, 7);
});

test('shouldKeepPolling: còn upload thì luôn poll', () => {
  assert.equal(shouldKeepPolling(summary({ total: 5, ready: 5, finished: true }), true), true);
  assert.equal(shouldKeepPolling(summary(), true), true);
});

test('shouldKeepPolling: hết upload, poll tới khi finished; lô rỗng thì dừng', () => {
  assert.equal(shouldKeepPolling(summary({ total: 5, queued: 5 }), false), true);
  assert.equal(shouldKeepPolling(summary({ total: 5, ready: 5, finished: true }), false), false);
  assert.equal(shouldKeepPolling(summary(), false), false);
});

test('batchProgressPercent tính theo ảnh đã xử lý xong trên mẫu số lớn hơn', () => {
  assert.equal(batchProgressPercent(summary({ total: 10, ready: 5, failed: 1, blocked: 1 }), 0), 70);
  // chưa upload hết: mẫu số lấy theo số ảnh dự kiến
  assert.equal(batchProgressPercent(summary({ total: 10, ready: 10, finished: true }), 40), 25);
  assert.equal(batchProgressPercent(summary(), 0), 0);
  assert.equal(batchProgressPercent(summary({ total: 3, ready: 3 }), 2), 100);
});
