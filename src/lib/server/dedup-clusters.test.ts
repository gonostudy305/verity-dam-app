import test from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';

import { DEDUP_CLUSTER_BUILD_VERSION, buildDedupLaneComponents, classifyTier, completeLinkComponents, listDedupClusters, pickCanonical, rebuildDedupClusters, sameMembers, unionFindComponents, type DedupAssetSnapshot, type DedupEdge } from './dedup-clusters';

test('classifyTier accepts one isolated evidence lane and rejects mixed evidence', () => {
  assert.equal(classifyTier(['phash']), 'near');
  assert.equal(classifyTier(['scene_embedding']), 'similar');
  assert.equal(classifyTier(['content_hash']), 'exact');
  assert.throws(() => classifyTier(['content_hash', 'phash']), /isolated evidence lane/);
});

test('unionFindComponents normalizes connected duplicate evidence into components', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .9, hammingDistance: 2 },
    { assetMinId: 'b', assetMaxId: 'c', method: 'scene_embedding', similarity: .8, hammingDistance: null },
    { assetMinId: 'x', assetMaxId: 'y', method: 'phash', similarity: .95, hammingDistance: 1 },
  ];
  assert.deepEqual(unionFindComponents(edges), [['a', 'b', 'c'], ['x', 'y']]);
});

test('pickCanonical uses usage, pixel area, then oldest creation time', () => {
  const chosen = pickCanonical([
    { id: 'new', usageCount: 2, published: false, sizeBytes: 10, width: 10, height: 10, createdAt: '2026-01-02' },
    { id: 'used', usageCount: 3, published: false, sizeBytes: 10, width: 1, height: 1, createdAt: '2026-01-03' },
    { id: 'old', usageCount: 3, published: false, sizeBytes: 10, width: 10, height: 10, createdAt: '2026-01-01' },
  ]);
  assert.equal(chosen.id, 'old');
});

test('pickCanonical prioritizes a published business dependency over a merely larger unused asset', () => {
  const chosen = pickCanonical([
    { id: 'large-unused', usageCount: 0, published: false, sizeBytes: 10, width: 4000, height: 3000, createdAt: '2026-01-01' },
    { id: 'published', usageCount: 0, published: true, sizeBytes: 10, width: 800, height: 600, createdAt: '2026-02-01' },
  ]);
  assert.equal(chosen.id, 'published');
});

function snapshots(ids: string[]): Map<string, DedupAssetSnapshot> {
  return new Map(ids.map((id, index) => [id, {
    id, usageCount: id === 'b' ? 5 : 0, published: false, sizeBytes: 10,
    width: 1000 - index, height: 1000, createdAt: `2026-01-0${index + 1}`,
  }]));
}

type StoredCluster = {
  id: string;
  status: 'open' | 'resolved' | 'dismissed';
  buildVersion: number;
  canonicalId: string | null;
  tier: 'exact' | 'near' | 'similar';
  methodSummary: Record<string, number>;
  memberCount: number;
  estimatedReclaimBytes: number;
  members: Array<{ id: string; variant: string; similarity: number | null }>;
};

/**
 * Deliberately small stateful query fake for the rebuild contract. It models
 * persisted cluster rows so the tests exercise the version/stale paths rather
 * than only the pure evidence builder.
 */
function fakeRebuildClient(edges: DedupEdge[], initial: StoredCluster[] = []) {
  const state = {
    clusters: initial.map((cluster) => ({ ...cluster, members: cluster.members.map((member) => ({ ...member })) })),
    nextId: 1,
  };
  const rawAssets = [...new Set(edges.flatMap((edge) => [edge.assetMinId, edge.assetMaxId]))].map((id, index) => ({
    id,
    usage_count: id === 'b' ? 5 : 0,
    publish_status: 'not_requested',
    published_at: null,
    dimensions: { size_bytes: 100, width: 1000 - index, height: 1000 },
    created_at: `2026-01-0${index + 1}`,
  }));
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('with content_hash_groups')) {
        return { rows: edges.map((edge) => ({
          asset_min_id: edge.assetMinId,
          asset_max_id: edge.assetMaxId,
          method: edge.method,
          similarity: edge.similarity,
          hamming_distance: edge.hammingDistance,
        })) };
      }
      if (sql.includes('from public.media_assets') && sql.includes('where id = any')) return { rows: rawAssets };
      if (sql.includes('from public.media_dedup_clusters c')) {
        return { rows: state.clusters.map((cluster) => ({
          id: cluster.id,
          status: cluster.status,
          build_version: cluster.buildVersion,
          canonical_media_asset_id: cluster.canonicalId,
          tier: cluster.tier,
          method_summary: cluster.methodSummary,
          member_count: cluster.memberCount,
          estimated_reclaim_bytes: cluster.estimatedReclaimBytes,
          members: cluster.members.map((member) => member.id).sort(),
        })) };
      }
      if (sql.includes('from public.media_dedup_cluster_members') && sql.includes('where cluster_id = any')) {
        return { rows: state.clusters.flatMap((cluster) => cluster.members.map((member) => ({ cluster_id: cluster.id, media_asset_id: member.id, variant: member.variant, similarity: member.similarity }))) };
      }
      if (sql.includes('update public.media_dedup_clusters')) {
        const [id, canonicalId, buildVersion, tier, methodSummary, memberCount, estimatedReclaimBytes] = params as [string, string, number, StoredCluster['tier'], string, number, number];
        const cluster = state.clusters.find((item) => item.id === id);
        assert.ok(cluster, `expected cluster ${id} to exist`);
        cluster.canonicalId = canonicalId;
        cluster.buildVersion = buildVersion;
        cluster.tier = tier;
        cluster.methodSummary = JSON.parse(methodSummary);
        cluster.memberCount = memberCount;
        cluster.estimatedReclaimBytes = estimatedReclaimBytes;
        return { rows: [] };
      }
      if (sql.startsWith('delete from public.media_dedup_cluster_members')) {
        const cluster = state.clusters.find((item) => item.id === params[0]);
        if (cluster) cluster.members = [];
        return { rows: [] };
      }
      if (sql.startsWith('insert into public.media_dedup_cluster_members')) {
        const [clusterId, id, variant, similarity] = params as [string, string, string, number | null];
        const cluster = state.clusters.find((item) => item.id === clusterId);
        assert.ok(cluster, `expected cluster ${clusterId} to exist`);
        cluster.members.push({ id, variant, similarity });
        return { rows: [] };
      }
      if (sql.startsWith('insert into public.media_dedup_clusters')) {
        const [canonicalId, buildVersion, tier, methodSummary, memberCount, estimatedReclaimBytes] = params as [string, number, StoredCluster['tier'], string, number, number];
        const id = `cluster-${state.nextId++}`;
        state.clusters.push({ id, status: 'open', buildVersion, canonicalId, tier, methodSummary: JSON.parse(methodSummary), memberCount, estimatedReclaimBytes, members: [] });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('insert into public.media_dedup_cluster_events')) return { rows: [] };
      if (sql.startsWith("delete from public.media_dedup_clusters where id=$1 and status='open'")) {
        state.clusters = state.clusters.filter((cluster) => cluster.id !== params[0] || cluster.status !== 'open');
        return { rows: [] };
      }
      if (sql.includes("select count(*)::text as count from public.media_dedup_clusters where status='open'")) {
        return { rows: [{ count: String(state.clusters.filter((cluster) => cluster.status === 'open').length) }] };
      }
      throw new Error(`unexpected rebuild query: ${sql}`);
    },
  };
  return { client: client as unknown as PoolClient, state };
}

test('mixed evidence never turns a scene chain into an exact cleanup cluster', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
    { assetMinId: 'b', assetMaxId: 'c', method: 'scene_embedding', similarity: .94, hammingDistance: null },
    { assetMinId: 'c', assetMaxId: 'd', method: 'scene_embedding', similarity: .93, hammingDistance: null },
  ];
  const lanes = buildDedupLaneComponents(edges, snapshots(['a', 'b', 'c', 'd']));
  assert.deepEqual(lanes.map((lane) => [lane.tier, lane.ids]), [
    ['exact', ['a', 'b']],
    ['similar', ['c', 'd']],
  ]);
  assert.equal(lanes.some((lane) => lane.tier === 'exact' && lane.ids.includes('c')), false);
});

test('stronger evidence claims an asset before weaker lanes can create another work item', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .99, hammingDistance: 1 },
    { assetMinId: 'a', assetMaxId: 'b', method: 'scene_embedding', similarity: .98, hammingDistance: null },
  ];

  const lanes = buildDedupLaneComponents(edges, snapshots(['a', 'b']));

  assert.deepEqual(lanes.map((lane) => [lane.tier, lane.ids]), [
    ['exact', ['a', 'b']],
  ]);
});

test('an exact pair blocks a weaker pHash edge from merging its member with a third asset', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
    { assetMinId: 'b', assetMaxId: 'c', method: 'phash', similarity: .99, hammingDistance: 1 },
  ];

  const lanes = buildDedupLaneComponents(edges, snapshots(['a', 'b', 'c']));

  assert.deepEqual(lanes.map((lane) => [lane.tier, lane.ids]), [
    ['exact', ['a', 'b']],
  ]);
});

test('complete-link pHash grouping rejects an A≈B≈C chain when A and C are not direct matches', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .98, hammingDistance: 1 },
    { assetMinId: 'b', assetMaxId: 'c', method: 'phash', similarity: .96, hammingDistance: 2 },
    { assetMinId: 'c', assetMaxId: 'd', method: 'phash', similarity: .98, hammingDistance: 1 },
  ];
  assert.deepEqual(completeLinkComponents(edges, snapshots(['a', 'b', 'c', 'd'])), [['a', 'b'], ['c', 'd']]);
});

test('complete-link pHash grouping keeps a fully connected trio together', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .98, hammingDistance: 1 },
    { assetMinId: 'a', assetMaxId: 'c', method: 'phash', similarity: .97, hammingDistance: 2 },
    { assetMinId: 'b', assetMaxId: 'c', method: 'phash', similarity: .96, hammingDistance: 2 },
  ];
  const lanes = buildDedupLaneComponents(edges, snapshots(['a', 'b', 'c']));
  assert.deepEqual(lanes.map((lane) => [lane.tier, lane.ids]), [['near', ['a', 'b', 'c']]]);
});

test('unclaimed scene edges stay as independent comparison pairs', () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'scene_embedding', similarity: .94, hammingDistance: null },
    { assetMinId: 'b', assetMaxId: 'c', method: 'scene_embedding', similarity: .93, hammingDistance: null },
  ];
  const lanes = buildDedupLaneComponents(edges, snapshots(['a', 'b', 'c']));
  assert.deepEqual(lanes.map((lane) => [lane.tier, lane.ids]), [
    ['similar', ['a', 'b']],
    ['similar', ['b', 'c']],
  ]);
});

test('rebuild upgrades overlapping v2 rows to one v3 exact work item and removes the stale copies', async () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .99, hammingDistance: 1 },
    { assetMinId: 'a', assetMaxId: 'b', method: 'scene_embedding', similarity: .98, hammingDistance: null },
  ];
  const { client, state } = fakeRebuildClient(edges, [
    { id: 'exact-v2', status: 'open', buildVersion: 2, canonicalId: 'b', tier: 'exact', methodSummary: { content_hash: 1 }, memberCount: 2, estimatedReclaimBytes: 100, members: [{ id: 'a', variant: 'exact_bytes', similarity: null }, { id: 'b', variant: 'canonical', similarity: null }] },
    { id: 'near-v2', status: 'open', buildVersion: 2, canonicalId: 'b', tier: 'near', methodSummary: { phash: 1 }, memberCount: 2, estimatedReclaimBytes: 100, members: [{ id: 'a', variant: 'phash_near', similarity: .99 }, { id: 'b', variant: 'canonical', similarity: null }] },
    { id: 'similar-v2', status: 'open', buildVersion: 2, canonicalId: 'b', tier: 'similar', methodSummary: { scene_embedding: 1 }, memberCount: 2, estimatedReclaimBytes: 0, members: [{ id: 'a', variant: 'scene_similar', similarity: .98 }, { id: 'b', variant: 'canonical', similarity: null }] },
  ]);

  const result = await rebuildDedupClusters(client, 'actor');

  assert.equal(result.clustersOpen, 1);
  assert.equal(result.clustersCreated, 0);
  assert.equal(result.clustersRemoved, 2);
  assert.deepEqual(state.clusters.map((cluster) => [cluster.tier, cluster.buildVersion, cluster.members.map((member) => member.id).sort()]), [
    ['exact', DEDUP_CLUSTER_BUILD_VERSION, ['a', 'b']],
  ]);
});

test('rebuild is idempotent after materializing a precedence-safe cluster', async () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
    { assetMinId: 'a', assetMaxId: 'b', method: 'phash', similarity: .99, hammingDistance: 1 },
  ];
  const { client, state } = fakeRebuildClient(edges);

  const first = await rebuildDedupClusters(client, 'actor');
  const afterFirst = state.clusters.map((cluster) => ({ ...cluster, members: cluster.members.map((member) => ({ ...member })) }));
  const second = await rebuildDedupClusters(client, 'actor');

  assert.deepEqual(first, { clustersOpen: 1, clustersCreated: 1, clustersRemoved: 0, suppressedSkipped: 0 });
  assert.deepEqual(second, { clustersOpen: 1, clustersCreated: 0, clustersRemoved: 0, suppressedSkipped: 0 });
  assert.deepEqual(state.clusters, afterFirst);
});

test('rebuild never reopens a member set that a reviewer already resolved', async () => {
  const edges: DedupEdge[] = [
    { assetMinId: 'a', assetMaxId: 'b', method: 'content_hash', similarity: null, hammingDistance: null },
  ];
  const { client, state } = fakeRebuildClient(edges, [
    { id: 'resolved-v3', status: 'resolved', buildVersion: DEDUP_CLUSTER_BUILD_VERSION, canonicalId: 'b', tier: 'exact', methodSummary: { content_hash: 1 }, memberCount: 2, estimatedReclaimBytes: 100, members: [{ id: 'a', variant: 'exact_bytes', similarity: null }, { id: 'b', variant: 'canonical', similarity: null }] },
  ]);

  const result = await rebuildDedupClusters(client, 'actor');

  assert.deepEqual(result, { clustersOpen: 0, clustersCreated: 0, clustersRemoved: 0, suppressedSkipped: 1 });
  assert.equal(state.clusters.length, 1);
  assert.equal(state.clusters[0]?.status, 'resolved');
});

test('sameMembers gives the builder a stable no-write check for an unchanged cluster', () => {
  const members = [{ id: 'a', variant: 'canonical', similarity: null }, { id: 'b', variant: 'phash_near', similarity: 0.92 }];
  assert.equal(sameMembers(members, [...members]), true);
  assert.equal(sameMembers(members, [{ ...members[0] }, { ...members[1], similarity: 0.91 }]), false);
});

test('listDedupClusters keeps count parameters separate from pagination parameters', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('count(*)')) return { rows: [{ total: '7' }] };
      if (sql.includes('select c.*')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const result = await listDedupClusters(client as unknown as PoolClient, { status: 'open', tier: 'near', limit: 1, offset: 0 });
  assert.equal(result.total, 7);
  assert.deepEqual(calls[0].params, ['open', 'near']);
  assert.deepEqual(calls[1].params, ['open', 'near', 1, 0]);
  assert.match(calls[1].sql, /limit \$3 offset \$4/);
});
