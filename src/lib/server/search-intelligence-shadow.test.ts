import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeQueryHash,
  computeTopKOverlap,
  DEFAULT_MAX_CONCURRENT_SHADOW_TASKS,
  resetActiveShadowTaskCountForTests,
  runSearchShadow,
  SearchShadowTelemetry,
} from './search-intelligence-shadow';
import { listNativeLibraryMediaIntelligent } from './native-search-intelligence';
import { RecoveryStage } from './search-intelligence-recovery';
import { parseMediaListParams } from '@/lib/media-api';
import type { NativeMediaListOptions } from './native-media';

const ADMIN_OPTIONS: NativeMediaListOptions = { includeDeleted: false, deletedOnly: false, canSeeInternal: true };

test('computeQueryHash: returns deterministic 16-character hex HMAC without hardcoded public salt', () => {
  const hash1 = computeQueryHash('camera acme g3');
  const hash2 = computeQueryHash('  CAMERA Acme G3  ');
  const hashDiff = computeQueryHash('camera eden c6n');

  assert.equal(hash1.length, 16);
  assert.equal(/^[0-9a-f]{16}$/.test(hash1), true);
  assert.equal(hash1, hash2, 'should be case-insensitive and trim whitespace');
  assert.notEqual(hash1, hashDiff, 'different queries must have different hashes');

  // Custom key produces distinct hash
  const customKeyHash = computeQueryHash('camera acme g3', 'custom-secret-key-123');
  assert.equal(customKeyHash.length, 16);
  assert.notEqual(hash1, customKeyHash);
});

test('computeTopKOverlap: accurately calculates top-k slice and intersection count', () => {
  const baseline = ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'];
  const shadow = ['id-3', 'id-5', 'id-7', 'id-8', 'id-9'];

  const res = computeTopKOverlap(baseline, shadow, 3);
  assert.deepEqual(res.baseline_topk_ids, ['id-1', 'id-2', 'id-3']);
  assert.deepEqual(res.shadow_topk_ids, ['id-3', 'id-5', 'id-7']);
  assert.equal(res.overlap_count, 1);

  const fullOverlap = computeTopKOverlap(baseline, baseline, 4);
  assert.equal(fullOverlap.overlap_count, 4);

  const zeroOverlap = computeTopKOverlap(['a', 'b'], ['c', 'd'], 5);
  assert.equal(zeroOverlap.overlap_count, 0);
});

test('runSearchShadow: success path produces complete telemetry with flags and notifies logger', async () => {
  let loggedPayload: SearchShadowTelemetry | null = null;
  let simulatedTime = 1000;

  const telemetry = await runSearchShadow({
    query: 'khóa thông minh acme',
    baselineData: [{ id: 'doc-1' }, { id: 'doc-2' }, { id: 'doc-3' }],
    runIntelligence: async () => ({
      data: [{ id: 'doc-2' }, { id: 'doc-4' }],
      total: 2,
      recoveryStageUsed: 'DIRECT_MATCH',
      semanticActive: true,
    }),
    topK: 5,
    logger: (payload) => {
      loggedPayload = payload;
    },
    now: () => {
      simulatedTime += 42;
      return simulatedTime;
    },
  });

  assert.equal(telemetry.event, 'search_shadow_telemetry');
  assert.equal(telemetry.query_hash, computeQueryHash('khóa thông minh acme'));
  assert.equal(telemetry.query_length, 'khóa thông minh acme'.length);
  assert.equal(telemetry.semantic_active, true);
  assert.equal(telemetry.lexical_exhausted, false);
  assert.equal(telemetry.semantic_rescued, false);
  assert.equal(telemetry.candidate_count, 2);
  assert.deepEqual(telemetry.baseline_topk_ids, ['doc-1', 'doc-2', 'doc-3']);
  assert.deepEqual(telemetry.shadow_topk_ids, ['doc-2', 'doc-4']);
  assert.equal(telemetry.overlap_count, 1);
  assert.equal(telemetry.recovery_stage, 'DIRECT_MATCH');
  assert.equal(telemetry.latency_ms >= 0, true);
  assert.equal(telemetry.error, undefined);

  assert.deepEqual(loggedPayload, telemetry);
});

test('runSearchShadow: honors SearchPlan.semanticEligible (exact SKU gates out semantic calls)', async () => {
  let receivedOptions: { enableSemanticOnExhausted: boolean; semanticEligible: boolean } | null = null;

  await runSearchShadow({
    query: 'HR-21', // exact SKU -> SearchPlan.semanticEligible is false
    baselineData: [{ id: 'doc-1' }],
    runIntelligence: async (opts) => {
      receivedOptions = opts;
      return {
        data: [{ id: 'doc-1' }],
        total: 1,
        recoveryStageUsed: 'DIRECT_MATCH',
        semanticActive: false,
      };
    },
  });

  assert.notEqual(receivedOptions, null);
  assert.equal(receivedOptions!.semanticEligible, false, 'exact SKU must have semanticEligible=false');
  assert.equal(receivedOptions!.enableSemanticOnExhausted, false, 'ineligible query must not enable semantic on exhausted');
});

test('runSearchShadow: semantic rescue on lexical EXHAUSTED sets flags correctly', async () => {
  let loggedPayload: SearchShadowTelemetry | null = null;

  const telemetry = await runSearchShadow({
    query: 'ảnh chụp góc nghiêng phòng ngủ ấm cúng',
    baselineData: [], // baseline returned 0 results
    runIntelligence: async (opts) => {
      assert.equal(opts.semanticEligible, true);
      assert.equal(opts.enableSemanticOnExhausted, true);
      return {
        data: [{ id: 'doc-rescued-1' }, { id: 'doc-rescued-2' }],
        total: 2,
        recoveryStageUsed: 'EXHAUSTED',
        semanticActive: true,
      };
    },
    logger: (payload) => {
      loggedPayload = payload;
    },
  });

  assert.equal(telemetry.lexical_exhausted, true);
  assert.equal(telemetry.semantic_rescued, true);
  assert.equal(telemetry.semantic_active, true);
  assert.equal(telemetry.candidate_count, 2);
  assert.deepEqual(telemetry.baseline_topk_ids, []);
  assert.deepEqual(telemetry.shadow_topk_ids, ['doc-rescued-1', 'doc-rescued-2']);
  assert.equal(telemetry.overlap_count, 0);
  assert.deepEqual(loggedPayload, telemetry);
});

test('runSearchShadow: concurrency semaphore throttles excess tasks gracefully', async () => {
  resetActiveShadowTaskCountForTests();
  let releaseTask1: () => void;
  const task1Wait = new Promise<void>((resolve) => {
    releaseTask1 = resolve;
  });

  // Start task 1 (will hold semaphore)
  const task1Promise = runSearchShadow({
    query: 'query 1',
    baselineData: [],
    maxConcurrentTasks: 1,
    runIntelligence: async () => {
      await task1Wait;
      return { data: [], total: 0 };
    },
  });

  // Task 2 arrives while task 1 is in-flight -> throttled immediately
  const throttledResult = await runSearchShadow({
    query: 'query 2',
    baselineData: [{ id: 'base-1' }],
    maxConcurrentTasks: 1,
    runIntelligence: async () => ({ data: [], total: 0 }),
  });

  assert.equal(throttledResult.recovery_stage, 'SHADOW_THROTTLED');
  assert.equal(throttledResult.error, 'MAX_CONCURRENT_SHADOW_TASKS_EXCEEDED');
  assert.deepEqual(throttledResult.baseline_topk_ids, ['base-1']);

  // Complete task 1
  releaseTask1!();
  await task1Promise;
  resetActiveShadowTaskCountForTests();
});

test('runSearchShadow: handles synchronous throw without crashing', async () => {
  const telemetry = await runSearchShadow({
    query: 'robot hut bui',
    baselineData: [{ id: 'doc-1' }],
    runIntelligence: () => {
      throw new Error('database offline');
    },
  });

  assert.equal(telemetry.event, 'search_shadow_telemetry');
  assert.equal(telemetry.semantic_active, false);
  assert.equal(telemetry.candidate_count, 0);
  assert.deepEqual(telemetry.shadow_topk_ids, []);
  assert.equal(telemetry.overlap_count, 0);
  assert.equal(telemetry.recovery_stage, 'ERROR');
  assert.equal(telemetry.error, 'database offline');
});

test('runSearchShadow: times out gracefully when intelligence exceeds timeoutMs', async () => {
  const telemetry = await runSearchShadow({
    query: 'den tran phong khach',
    baselineData: [{ id: 'doc-1' }],
    timeoutMs: 20,
    runIntelligence: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        data: [{ id: 'doc-99' }],
        total: 1,
        recoveryStageUsed: 'SLOW',
        semanticActive: true,
      };
    },
  });

  assert.equal(telemetry.semantic_active, false);
  assert.equal(telemetry.recovery_stage, 'TIMEOUT');
  assert.match(telemetry.error || '', /SHADOW_TIMEOUT_20MS/);
});

test('SERVE path invariant: listNativeLibraryMediaIntelligent honestly returns empty on EXHAUSTED by default', async () => {
  const pool = {
    query: async () => ({ rows: [] }),
  };
  const result = await listNativeLibraryMediaIntelligent(
    parseMediaListParams(new URLSearchParams({ q: 'nonexistentquery123xyz' })),
    'nonexistentquery123xyz',
    ADMIN_OPTIONS,
    { pool, synonymsProvider: async () => [] },
  );

  assert.deepEqual(result.data, [], 'SERVE path must return empty array on EXHAUSTED');
  assert.equal(result.total, 0);
  assert.equal(result.recoveryStageUsed, RecoveryStage.EXHAUSTED);
  assert.equal(result.semanticActive, false);
});
