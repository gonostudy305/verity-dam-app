import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { buildResolveEventPayload, normalizedRemoveIds, protectionReasons, resolveDedupCluster } from './cluster-resolve';
import { DEDUP_CLUSTER_BUILD_VERSION } from './dedup-clusters';
import { ApiError } from './http';

test('normalizedRemoveIds keeps canonical and never removes the whole cluster', () => {
  assert.deepEqual(normalizedRemoveIds(['a', 'b', 'c'], { resolution: 'keep_one', keepAssetId: 'a', removeAssetIds: ['b', 'c'] }), { keepId: 'a', removeIds: ['b', 'c'] });
  assert.throws(() => normalizedRemoveIds(['a'], { resolution: 'keep_one', keepAssetId: 'a' }), /Cluster phải còn/);
});

test('protectionReasons combines usage and publication guards', () => {
  assert.deepEqual(protectionReasons({ usage_count: 1, has_usage: false, publish_status: 'published', published_at: null }), ['in_use', 'published']);
  assert.deepEqual(protectionReasons({ usage_count: 0, has_usage: false, publish_status: 'not_requested', published_at: null }), []);
});

test('resolve event payload records forced protection override and selection', () => {
  const payload = buildResolveEventPayload({ resolution: 'keep_one', keepAssetId: 'a', forceConfirm: true, note: 'reviewed' }, 'a', ['b'], []);
  assert.equal(payload.forced, true);
  assert.deepEqual(payload.remove_asset_ids, ['b']);
});

function fakeResolveClient(protectionRows: unknown[] = [], tier = 'near', buildVersion = DEDUP_CLUSTER_BUILD_VERSION) {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('from public.media_dedup_clusters where id=$1 for update')) return { rows: [{ id: 'cluster', status: 'open', tier, build_version: buildVersion, canonical_media_asset_id: 'asset-a' }] };
      if (sql.includes('from public.media_dedup_cluster_members where cluster_id=$1')) return { rows: [{ media_asset_id: 'asset-a' }, { media_asset_id: 'asset-b' }] };
      if (sql.includes('select a.id, a.title')) return { rows: protectionRows };
      return { rows: [], rowCount: 1 };
    },
  };
  return { client: client as unknown as PoolClient, calls };
}

test('keep_all changes only cluster decisions and lifecycle, never soft-deletes assets', async () => {
  const { client, calls } = fakeResolveClient();
  const result = await resolveDedupCluster(client, 'cluster', 'actor', { resolution: 'keep_all' });
  assert.deepEqual(result.removedAssetIds, []);
  assert.equal(calls.some((sql) => sql.includes('update public.media_assets') || sql.includes('media_ingest_jobs') || sql.includes('pair_suppressions')), false);
  assert.equal(calls.some((sql) => sql.includes('media_dedup_cluster_events')), true);
});

test('protected removal fails before any mutation', async () => {
  const { client, calls } = fakeResolveClient([{ id: 'asset-b', title: 'Used asset', usage_count: 1, has_usage: false, publish_status: 'not_requested', published_at: null }]);
  await assert.rejects(
    () => resolveDedupCluster(client, 'cluster', 'actor', { resolution: 'keep_one', keepAssetId: 'asset-a', removeAssetIds: ['asset-b'] }),
    (error: unknown) => error instanceof ApiError && error.code === 'PROTECTED_ASSETS',
  );
  assert.equal(calls.some((sql) => sql.startsWith('update ') || sql.startsWith('insert ')), false);
});

test('similar suggestions reject every soft-delete resolution before member mutation', async () => {
  const { client, calls } = fakeResolveClient([], 'similar');
  await assert.rejects(
    () => resolveDedupCluster(client, 'cluster', 'actor', { resolution: 'keep_one', keepAssetId: 'asset-a', removeAssetIds: ['asset-b'] }),
    (error: unknown) => error instanceof ApiError && error.code === 'SIMILAR_CANNOT_REMOVE',
  );
  assert.equal(calls.some((sql) => sql.includes('media_dedup_cluster_members where cluster_id')), false);
  assert.equal(calls.some((sql) => sql.startsWith('update ') || sql.startsWith('insert ')), false);
});

test('a stale materialized cluster fails closed until the current semantics rebuild it', async () => {
  const { client, calls } = fakeResolveClient([], 'exact', DEDUP_CLUSTER_BUILD_VERSION - 1);
  await assert.rejects(
    () => resolveDedupCluster(client, 'cluster', 'actor', { resolution: 'keep_one', keepAssetId: 'asset-a', removeAssetIds: ['asset-b'] }),
    (error: unknown) => error instanceof ApiError && error.code === 'CLUSTER_REBUILD_REQUIRED',
  );
  assert.equal(calls.some((sql) => sql.includes('media_dedup_cluster_members where cluster_id')), false);
  assert.equal(calls.some((sql) => sql.startsWith('update ') || sql.startsWith('insert ')), false);
});
