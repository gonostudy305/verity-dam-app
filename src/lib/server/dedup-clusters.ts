import type { PoolClient } from 'pg';

import type {
  DedupCluster,
  DedupClusterMember,
  DedupMemberDecision,
  DedupMemberVariant,
  DedupTier,
  DedupWorkbenchSummary,
} from '@/types/dedup';
import { mapMediaAsset } from './media-mapper';
import { resolveMediaUrls } from './native-media';

export const DEDUP_ADVISORY_LOCK_KEY = 2_106_090_308;
export const DEDUP_EDGE_LIMIT = 100_000;
/**
 * A cluster is a materialized interpretation of evidence, not the evidence
 * itself. Increment this whenever its membership semantics change so every
 * open cluster is rebuilt before it can be reviewed or resolved.
 */
export const DEDUP_CLUSTER_BUILD_VERSION = 3;

export interface DedupEdge {
  assetMinId: string;
  assetMaxId: string;
  method: string;
  similarity: number | null;
  hammingDistance: number | null;
}

export interface DedupAssetSnapshot {
  id: string;
  usageCount: number;
  published: boolean;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: string;
}

export function normalizePair(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}

export function unionFindComponents(edges: DedupEdge[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const current = parent.get(id);
    if (!current || current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    if (!parent.has(left)) parent.set(left, left);
    if (!parent.has(right)) parent.set(right, right);
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  for (const edge of edges) union(edge.assetMinId, edge.assetMaxId);
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const group = groups.get(root) || [];
    group.push(id);
    groups.set(root, group);
  }
  return [...groups.values()].map((ids) => ids.sort());
}

export function classifyTier(methods: Iterable<string>): DedupTier {
  const values = new Set(methods);
  if (values.size !== 1) {
    throw new Error('A dedup tier must be classified from one isolated evidence lane');
  }
  if (values.has('content_hash')) return 'exact';
  if (values.has('phash')) return 'near';
  if (values.has('scene_embedding')) return 'similar';
  throw new Error('Unsupported dedup evidence method');
}

export function compareCanonicalCandidates(left: DedupAssetSnapshot, right: DedupAssetSnapshot) {
  return Number(right.published) - Number(left.published)
    || right.usageCount - left.usageCount
    || (right.width * right.height) - (left.width * left.height)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

export function pickCanonical(assets: DedupAssetSnapshot[]): DedupAssetSnapshot {
  if (!assets.length) throw new Error('Cannot pick a canonical asset from an empty component');
  return [...assets].sort(compareCanonicalCandidates)[0];
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

function numberValue(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function snapshotFromRow(row: Record<string, unknown>): DedupAssetSnapshot {
  const dimensions = jsonObject(row.dimensions);
  return {
    id: String(row.id),
    usageCount: numberValue(row.usage_count),
    published: row.publish_status === 'published' || Boolean(row.published_at),
    sizeBytes: Math.max(0, numberValue(dimensions.size_bytes)),
    width: Math.max(0, numberValue(dimensions.width)),
    height: Math.max(0, numberValue(dimensions.height)),
    createdAt: String(row.created_at || ''),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}

interface MaterializedCluster {
  tier: DedupTier;
  canonicalId: string;
  methodSummary: Record<string, number>;
  memberCount: number;
  estimatedReclaimBytes: number;
  members: Array<{ id: string; variant: DedupMemberVariant; similarity: number | null }>;
}

interface DedupLaneComponent {
  tier: DedupTier;
  ids: string[];
  edges: DedupEdge[];
}

function pairKey(first: string, second: string) {
  return normalizePair(first, second).join(':');
}

function compareNearCandidates(leftId: string, rightId: string, rootId: string, edgesByPair: Map<string, DedupEdge>, assets: Map<string, DedupAssetSnapshot>) {
  const left = edgesByPair.get(pairKey(rootId, leftId));
  const right = edgesByPair.get(pairKey(rootId, rightId));
  const leftDistance = left?.hammingDistance ?? Number.POSITIVE_INFINITY;
  const rightDistance = right?.hammingDistance ?? Number.POSITIVE_INFINITY;
  const leftSimilarity = left?.similarity ?? Number.NEGATIVE_INFINITY;
  const rightSimilarity = right?.similarity ?? Number.NEGATIVE_INFINITY;
  return leftDistance - rightDistance
    || rightSimilarity - leftSimilarity
    || compareCanonicalCandidates(assets.get(leftId)!, assets.get(rightId)!);
}

/**
 * pHash distance is not transitive: A≈B and B≈C does not mean A≈C.
 * Build non-overlapping complete-link groups instead of a union-find chain.
 * Precision matters more than recall because this lane can enter a manual
 * cleanup flow; an ungrouped candidate remains available as a future pair.
 */
export function completeLinkComponents(edges: DedupEdge[], assets: Map<string, DedupAssetSnapshot>): string[][] {
  const edgesByPair = new Map(edges.map((edge) => [pairKey(edge.assetMinId, edge.assetMaxId), edge]));
  const remaining = new Set(edges.flatMap((edge) => [edge.assetMinId, edge.assetMaxId]).filter((id) => assets.has(id)));
  const components: string[][] = [];

  while (remaining.size) {
    const root = [...remaining].sort((left, right) => compareCanonicalCandidates(assets.get(left)!, assets.get(right)!))[0];
    const candidates = [...remaining]
      .filter((id) => id !== root && edgesByPair.has(pairKey(root, id)))
      .sort((left, right) => compareNearCandidates(left, right, root, edgesByPair, assets));
    const component = [root];
    for (const candidate of candidates) {
      if (component.every((member) => member === candidate || edgesByPair.has(pairKey(member, candidate)))) component.push(candidate);
    }
    for (const id of component) remaining.delete(id);
    if (component.length >= 2) components.push(component.sort());
  }
  return components;
}

/**
 * Materialize at most one cleanup work item for an asset across destructive
 * evidence lanes. Exact bytes win over pHash; both win over scene similarity.
 * This prevents an asset from reappearing as a weaker, conflicting decision
 * after it has already been claimed by stronger evidence.
 *
 * Scene pairs deliberately remain independent from one another: they are
 * comparison-only suggestions, so A~B and B~C must never be graph-merged.
 */
export function buildDedupLaneComponents(edges: DedupEdge[], assets: Map<string, DedupAssetSnapshot>): DedupLaneComponent[] {
  const isLiveEdge = (edge: DedupEdge) => assets.has(edge.assetMinId) && assets.has(edge.assetMaxId);
  const laneEdges = {
    exact: edges.filter((edge) => edge.method === 'content_hash' && isLiveEdge(edge)),
    near: edges.filter((edge) => edge.method === 'phash' && isLiveEdge(edge)),
    similar: edges.filter((edge) => edge.method === 'scene_embedding' && isLiveEdge(edge)),
  };
  const componentEdges = (ids: string[], source: DedupEdge[]) => {
    const memberSet = new Set(ids);
    return source.filter((edge) => memberSet.has(edge.assetMinId) && memberSet.has(edge.assetMaxId));
  };
  const claimedAssetIds = new Set<string>();
  const unclaimedEdges = (source: DedupEdge[]) => source.filter((edge) => (
    !claimedAssetIds.has(edge.assetMinId) && !claimedAssetIds.has(edge.assetMaxId)
  ));
  const claim = (components: DedupLaneComponent[]) => {
    for (const component of components) {
      for (const id of component.ids) claimedAssetIds.add(id);
    }
  };
  const exact = unionFindComponents(laneEdges.exact)
    .filter((ids) => ids.length >= 2)
    .map((ids) => ({ tier: 'exact' as const, ids, edges: componentEdges(ids, laneEdges.exact) }));
  claim(exact);

  const nearEdges = unclaimedEdges(laneEdges.near);
  const near = completeLinkComponents(nearEdges, assets)
    .map((ids) => ({ tier: 'near' as const, ids, edges: componentEdges(ids, nearEdges) }));
  claim(near);

  // Scene evidence is an association suggestion, not an equivalence relation.
  // Keep each unclaimed pair explicit instead of letting a graph chain imply
  // deletion. Similar pairs can overlap each other, but never exact/near work.
  const similar = unclaimedEdges(laneEdges.similar).map((edge) => ({
    tier: 'similar' as const,
    ids: [edge.assetMinId, edge.assetMaxId].sort(),
    edges: [edge],
  }));
  return [...exact, ...near, ...similar];
}

function materializeComponent(tier: DedupTier, component: string[], edges: DedupEdge[], assets: Map<string, DedupAssetSnapshot>): MaterializedCluster {
  const componentSet = new Set(component);
  const componentEdges = edges.filter((edge) => componentSet.has(edge.assetMinId) && componentSet.has(edge.assetMaxId));
  const snapshots = component.map((id) => assets.get(id)).filter((asset): asset is DedupAssetSnapshot => Boolean(asset));
  const canonical = pickCanonical(snapshots);
  const methodSummary: Record<string, number> = {};
  for (const edge of componentEdges) methodSummary[edge.method] = (methodSummary[edge.method] || 0) + 1;

  const members = component.map((id) => {
    if (id === canonical.id) return { id, variant: 'canonical' as const, similarity: null };
    const related = componentEdges.filter((edge) => (
      (edge.assetMinId === id && edge.assetMaxId === canonical.id)
      || (edge.assetMaxId === id && edge.assetMinId === canonical.id)
    ));
    const methods = new Set(related.map((edge) => edge.method));
    const variant: DedupMemberVariant = methods.has('content_hash')
      ? 'exact_bytes'
      : methods.has('phash') ? 'phash_near' : 'scene_similar';
    const similarities = related.map((edge) => edge.similarity).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return { id, variant, similarity: similarities.length ? Math.max(...similarities) : null };
  });
  const totalBytes = snapshots.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  return {
    tier,
    canonicalId: canonical.id,
    methodSummary,
    memberCount: component.length,
    // Similarity is comparison-only. Showing a reclaim estimate would imply
    // that either image is disposable, which is not a valid inference.
    estimatedReclaimBytes: tier === 'similar' ? 0 : Math.max(0, totalBytes - canonical.sizeBytes),
    members,
  };
}

export function sameMembers(left: Array<{ id: string; variant: string; similarity: number | null }>, right: Array<{ id: string; variant: string; similarity: number | null }>) {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    return member.id === other.id && member.variant === other.variant && member.similarity === other.similarity;
  });
}

export interface RebuildDedupResult {
  clustersOpen: number;
  clustersCreated: number;
  clustersRemoved: number;
  suppressedSkipped: number;
}

export async function rebuildDedupClusters(client: PoolClient, actorId?: string): Promise<RebuildDedupResult> {
  await client.query('select pg_advisory_xact_lock($1)', [DEDUP_ADVISORY_LOCK_KEY]);
  const edgeResult = await client.query<DedupEdge & { asset_min_id: string; asset_max_id: string; hamming_distance: number | null }>(
    `with content_hash_groups as (
       select content_hash, array_agg(id order by id) as asset_ids
         from public.media_assets
        where content_hash is not null and deleted_at is null and review_state <> 'rejected'
        group by content_hash
       having count(*) > 1
     ), raw_edges as (
       select case when m.media_asset_id < m.candidate_media_asset_id then m.media_asset_id else m.candidate_media_asset_id end as asset_min_id,
              case when m.media_asset_id < m.candidate_media_asset_id then m.candidate_media_asset_id else m.media_asset_id end as asset_max_id,
              m.method, m.similarity, m.hamming_distance
         from public.media_dedup_matches m
         join public.media_assets a on a.id = m.media_asset_id and a.deleted_at is null and a.review_state <> 'rejected'
         join public.media_assets b on b.id = m.candidate_media_asset_id and b.deleted_at is null and b.review_state <> 'rejected'
        where m.media_asset_id <> m.candidate_media_asset_id
          and m.method in ('phash', 'scene_embedding')
       union all
       select g.asset_ids[left_idx], g.asset_ids[right_idx], 'content_hash', null::real, null::integer
         from content_hash_groups g
         cross join lateral generate_subscripts(g.asset_ids, 1) as left_indexes(left_idx)
         cross join lateral generate_subscripts(g.asset_ids, 1) as right_indexes(right_idx)
        where left_idx < right_idx
     ), normalized as (
       select asset_min_id, asset_max_id, method, max(similarity) as similarity, min(hamming_distance) as hamming_distance
         from raw_edges
        group by asset_min_id, asset_max_id, method
     )
     select n.asset_min_id::text, n.asset_max_id::text, n.method, n.similarity, n.hamming_distance
       from normalized n
       left join public.media_dedup_pair_suppressions s
         on s.asset_min_id = n.asset_min_id and s.asset_max_id = n.asset_max_id
      where s.asset_min_id is null
      limit $1`,
    [DEDUP_EDGE_LIMIT + 1],
  );
  if (edgeResult.rows.length > DEDUP_EDGE_LIMIT) {
    console.error(`[dedup] evidence edge limit exceeded (${DEDUP_EDGE_LIMIT}); rebuild aborted without materializing a partial snapshot`);
    throw new Error('DEDUP_EDGE_LIMIT_EXCEEDED');
  }
  const edges: DedupEdge[] = edgeResult.rows.map((row) => ({
    assetMinId: row.asset_min_id,
    assetMaxId: row.asset_max_id,
    method: row.method,
    similarity: row.similarity,
    hammingDistance: row.hamming_distance,
  }));
  const allIds = [...new Set(edges.flatMap((edge) => [edge.assetMinId, edge.assetMaxId]))];
  const assetResult = allIds.length ? await client.query<Record<string, unknown>>(
    `select id, usage_count, publish_status, published_at, dimensions, created_at
       from public.media_assets
      where id = any($1::uuid[])
        and deleted_at is null
        and review_state <> 'rejected'`,
    [allIds],
  ) : { rows: [] } as { rows: Record<string, unknown>[] };
  const assets = new Map(assetResult.rows.map((row) => [String(row.id), snapshotFromRow(row)]));
  const materialized = buildDedupLaneComponents(edges, assets)
    .map((component) => materializeComponent(
      component.tier,
      component.ids.filter((id) => assets.has(id)),
      component.edges,
      assets,
    ))
    .filter((cluster) => cluster.memberCount >= 2);

  const existing = await client.query<{ id: string; status: 'open' | 'resolved' | 'dismissed'; build_version: number; canonical_media_asset_id: string | null; tier: DedupTier; method_summary: unknown; member_count: number; estimated_reclaim_bytes: string | number; members: string[] }>(
    `select c.id, c.status, c.build_version, c.canonical_media_asset_id, c.tier, c.method_summary,
            c.member_count, c.estimated_reclaim_bytes,
            coalesce(array_agg(m.media_asset_id::text order by m.media_asset_id), '{}') as members
       from public.media_dedup_clusters c
       left join public.media_dedup_cluster_members m on m.cluster_id = c.id
      where c.status in ('open', 'resolved', 'dismissed')
      group by c.id`,
  );
  const existingByKey = new Map<string, typeof existing.rows[number]>();
  const membersByCluster = new Map<string, Array<{ id: string; variant: string; similarity: number | null }>>();
  const memberRows = await client.query<{ cluster_id: string; media_asset_id: string; variant: string; similarity: number | null }>(
    `select cluster_id, media_asset_id, variant, similarity from public.media_dedup_cluster_members
      where cluster_id = any($1::uuid[])`,
    [existing.rows.map((row) => row.id)],
  );
  for (const row of existing.rows) existingByKey.set(row.members.slice().sort().join(','), row);
  for (const row of memberRows.rows) {
    const list = membersByCluster.get(row.cluster_id) || [];
    list.push({ id: row.media_asset_id, variant: row.variant, similarity: row.similarity });
    membersByCluster.set(row.cluster_id, list);
  }

  let clustersCreated = 0;
  let suppressedSkipped = 0;
  const handledOpenIds = new Set<string>();
  const closedMembers = existing.rows.filter((row) => row.status !== 'open');
  for (const cluster of materialized) {
    const key = cluster.members.map((member) => member.id).sort().join(',');
    if (closedMembers.some((row) => cluster.members.every((member) => row.members.includes(member.id)))) {
      suppressedSkipped += 1;
      continue;
    }
    const current = existingByKey.get(key);
    if (current?.status === 'open') {
      handledOpenIds.add(current.id);
      const currentMembers = membersByCluster.get(current.id) || [];
      const changed = current.canonical_media_asset_id !== cluster.canonicalId
        || Number(current.build_version) !== DEDUP_CLUSTER_BUILD_VERSION
        || current.tier !== cluster.tier
        || current.member_count !== cluster.memberCount
        || Number(current.estimated_reclaim_bytes) !== cluster.estimatedReclaimBytes
        || stableJson(jsonObject(current.method_summary)) !== stableJson(cluster.methodSummary)
        || !sameMembers(currentMembers.sort((a, b) => a.id.localeCompare(b.id)), cluster.members.slice().sort((a, b) => a.id.localeCompare(b.id)));
      if (!changed) continue;
      await client.query(
        `update public.media_dedup_clusters
            set canonical_media_asset_id=$2, build_version=$3, tier=$4, method_summary=$5::jsonb,
                member_count=$6, estimated_reclaim_bytes=$7, updated_at=now()
          where id=$1`,
        [current.id, cluster.canonicalId, DEDUP_CLUSTER_BUILD_VERSION, cluster.tier, JSON.stringify(cluster.methodSummary), cluster.memberCount, cluster.estimatedReclaimBytes],
      );
      await client.query('delete from public.media_dedup_cluster_members where cluster_id=$1', [current.id]);
      for (const member of cluster.members) {
        await client.query(
          `insert into public.media_dedup_cluster_members(cluster_id, media_asset_id, variant, similarity)
           values ($1,$2,$3,$4)`, [current.id, member.id, member.variant, member.similarity],
        );
      }
      await client.query(
        `insert into public.media_dedup_cluster_events(cluster_id, action, payload, actor_id)
         values ($1,'rebuilt_reopened',$2::jsonb,$3)`,
        [current.id, JSON.stringify({ member_ids: cluster.members.map((member) => member.id) }), actorId || null],
      );
      continue;
    }
    const inserted = await client.query<{ id: string }>(
      `insert into public.media_dedup_clusters
        (canonical_media_asset_id, build_version, tier, method_summary, member_count, estimated_reclaim_bytes)
       values ($1,$2,$3,$4::jsonb,$5,$6)
       returning id`,
      [cluster.canonicalId, DEDUP_CLUSTER_BUILD_VERSION, cluster.tier, JSON.stringify(cluster.methodSummary), cluster.memberCount, cluster.estimatedReclaimBytes],
    );
    const clusterId = inserted.rows[0]?.id;
    if (!clusterId) throw new Error('Dedup cluster insert returned no id');
    for (const member of cluster.members) {
      await client.query(
        `insert into public.media_dedup_cluster_members(cluster_id, media_asset_id, variant, similarity)
         values ($1,$2,$3,$4)`, [clusterId, member.id, member.variant, member.similarity],
      );
    }
    await client.query(
      `insert into public.media_dedup_cluster_events(cluster_id, action, payload, actor_id)
       values ($1,'built',$2::jsonb,$3)`,
      [clusterId, JSON.stringify({ member_ids: cluster.members.map((member) => member.id) }), actorId || null],
    );
    clustersCreated += 1;
  }

  // Only the exact open row selected above is retained. Comparing member sets
  // here is unsafe: a v2 rebuild could leave duplicate exact/near/similar rows
  // with identical members open, because all of them match the same new key.
  const stale = existing.rows.filter((row) => row.status === 'open' && !handledOpenIds.has(row.id));
  for (const row of stale) {
    await client.query('delete from public.media_dedup_clusters where id=$1 and status=\'open\'', [row.id]);
  }
  const openCount = await client.query<{ count: string }>(`select count(*)::text as count from public.media_dedup_clusters where status='open'`);
  return { clustersOpen: Number(openCount.rows[0]?.count || 0), clustersCreated, clustersRemoved: stale.length, suppressedSkipped };
}

export async function getDedupWorkbenchSummary(client: PoolClient | { query: PoolClient['query'] }): Promise<DedupWorkbenchSummary> {
  const result = await client.query<{ exact: string; near: string; similar: string; attention: string; total_reclaim: string; last_built_at: string | null }>(
    `select count(*) filter (where tier='exact' and status='open')::text as exact,
            count(*) filter (where tier='near' and status='open')::text as near,
            count(*) filter (where tier='similar' and status='open')::text as similar,
            count(*) filter (where status='open' and tier in ('exact','near'))::text as attention,
            coalesce(sum(estimated_reclaim_bytes) filter (where status='open' and tier in ('exact','near')),0)::text as total_reclaim,
            (select max(created_at) from public.media_dedup_cluster_events
              where action in ('built','rebuilt_reopened')) as last_built_at
       from public.media_dedup_clusters`,
  );
  const row = result.rows[0];
  return {
    counts_by_tier: { exact: Number(row?.exact || 0), near: Number(row?.near || 0), similar: Number(row?.similar || 0) },
    attention_count: Number(row?.attention || 0),
    total_estimated_reclaim_bytes: Number(row?.total_reclaim || 0),
    last_built_at: row?.last_built_at || null,
  };
}

export async function getDedupClusterAttentionCount(client: PoolClient | { query: PoolClient['query'] }): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from public.media_dedup_clusters where status='open' and tier in ('exact','near')`,
  );
  return Number(result.rows[0]?.count || 0);
}

export async function getLatestClusterResolutionEvent(client: PoolClient | { query: PoolClient['query'] }, clusterId: string) {
  const result = await client.query<{ action: 'resolved' | 'dismissed'; payload: unknown; created_at: string }>(
    `select action, payload, created_at
       from public.media_dedup_cluster_events
      where cluster_id=$1 and action in ('resolved','dismissed')
      order by created_at desc, id desc
      limit 1`,
    [clusterId],
  );
  return result.rows[0] || null;
}

export async function reopenCluster(client: PoolClient, clusterId: string) {
  const result = await client.query<{ id: string }>(
    `update public.media_dedup_clusters
        set status='open', resolution=null, resolved_by=null, resolved_at=null, updated_at=now()
      where id=$1 and status in ('resolved','dismissed')
      returning id`,
    [clusterId],
  );
  return Boolean(result.rows[0]);
}

export interface DedupClusterListOptions {
  status: 'open' | 'resolved' | 'dismissed';
  tier?: DedupTier;
  tiers?: DedupTier[];
  limit: number;
  offset: number;
}

export async function listDedupClusters(client: PoolClient | { query: PoolClient['query'] }, options: DedupClusterListOptions) {
  const values: unknown[] = [options.status];
  const tierClause = options.tier
    ? ` and c.tier = $${values.push(options.tier)}`
    : options.tiers?.length
      ? ` and c.tier = any($${values.push(options.tiers)}::text[])`
      : '';
  const countValues = [...values];
  const count = await client.query<{ total: string }>(
    `select count(*)::text as total from public.media_dedup_clusters c where c.status = $1${tierClause}`,
    countValues,
  );
  const rowValues = [...values, options.limit, options.offset];
  const rows = await client.query<Record<string, unknown>>(
    `select c.* from public.media_dedup_clusters c
      where c.status = $1${tierClause}
      order by case c.tier when 'exact' then 0 when 'near' then 1 else 2 end,
               c.estimated_reclaim_bytes desc, c.updated_at desc
      limit $${values.length + 1} offset $${values.length + 2}`,
    rowValues,
  );
  const clusters = await Promise.all(rows.rows.map((row) => mapDedupCluster(row)));
  const clusterIds = clusters.map((cluster) => cluster.id);
  if (clusterIds.length) {
    const memberRows = await client.query<Record<string, unknown>>(
      `select m.cluster_id, m.media_asset_id, m.variant, m.similarity, m.decision, a.*
         from public.media_dedup_cluster_members m
         join public.media_assets a on a.id = m.media_asset_id
        where m.cluster_id = any($1::uuid[])
        order by case when m.variant = 'canonical' then 0 else 1 end, a.created_at asc`,
      [clusterIds],
    );
    const urls = resolveMediaUrls(memberRows.rows);
    const membersByCluster = new Map<string, DedupClusterMember[]>();
    for (const row of memberRows.rows) {
      const members = membersByCluster.get(String(row.cluster_id)) || [];
      members.push({
        media_asset_id: String(row.media_asset_id),
        asset: mapMediaAsset(row, urls),
        variant: row.variant as DedupMemberVariant,
        similarity: typeof row.similarity === 'number' ? row.similarity : null,
        decision: (row.decision || 'undecided') as DedupMemberDecision,
      });
      membersByCluster.set(String(row.cluster_id), members);
    }
    for (const cluster of clusters) cluster.members = membersByCluster.get(cluster.id) || [];
  }
  return { clusters, total: Number(count.rows[0]?.total || 0) };
}

export async function getDedupClusterWithMembers(client: PoolClient | { query: PoolClient['query'] }, id: string) {
  const result = await client.query<Record<string, unknown>>(
    `select c.id as cluster_id, c.build_version, c.canonical_media_asset_id, c.tier, c.status,
            c.resolution, c.method_summary, c.member_count, c.estimated_reclaim_bytes,
            c.resolved_at, c.created_at as cluster_created_at, c.updated_at as cluster_updated_at,
            m.media_asset_id, m.variant, m.similarity, m.decision, a.*
       from public.media_dedup_clusters c
       join public.media_dedup_cluster_members m on m.cluster_id = c.id
       join public.media_assets a on a.id = m.media_asset_id
      where c.id = $1
      order by case when m.variant = 'canonical' then 0 else 1 end,
               coalesce(m.similarity, 0) desc, a.created_at asc`,
    [id],
  );
  const first = result.rows[0];
  if (!first) return null;
  const cluster: DedupCluster = {
    id: String(first.cluster_id),
    build_version: numberValue(first.build_version),
    canonical_media_asset_id: typeof first.canonical_media_asset_id === 'string' ? first.canonical_media_asset_id : null,
    tier: first.tier as DedupTier,
    status: first.status as DedupCluster['status'],
    resolution: (first.resolution as DedupCluster['resolution']) || null,
    method_summary: jsonObject(first.method_summary) as Record<string, number>,
    member_count: numberValue(first.member_count),
    estimated_reclaim_bytes: numberValue(first.estimated_reclaim_bytes),
    resolved_at: typeof first.resolved_at === 'string' ? first.resolved_at : undefined,
    created_at: String(first.cluster_created_at),
    updated_at: String(first.cluster_updated_at),
  };
  const urls = resolveMediaUrls(result.rows);
  cluster.members = result.rows.map((row) => ({
    media_asset_id: String(row.media_asset_id),
    asset: mapMediaAsset(row, urls),
    variant: row.variant as DedupMemberVariant,
    similarity: typeof row.similarity === 'number' ? row.similarity : null,
    decision: (row.decision || 'undecided') as DedupMemberDecision,
  }));
  return cluster;
}

export async function getDedupCluster(client: PoolClient | { query: PoolClient['query'] }, id: string) {
  return getDedupClusterWithMembers(client, id);
}

export async function mapDedupCluster(row: Record<string, unknown>): Promise<DedupCluster> {
  return {
    id: String(row.id),
    build_version: numberValue(row.build_version),
    canonical_media_asset_id: typeof row.canonical_media_asset_id === 'string' ? row.canonical_media_asset_id : null,
    tier: row.tier as DedupTier,
    status: row.status as DedupCluster['status'],
    resolution: (row.resolution as DedupCluster['resolution']) || null,
    method_summary: jsonObject(row.method_summary) as Record<string, number>,
    member_count: numberValue(row.member_count),
    estimated_reclaim_bytes: numberValue(row.estimated_reclaim_bytes),
    resolved_at: typeof row.resolved_at === 'string' ? row.resolved_at : undefined,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function hydrateDedupMembers(rows: Record<string, unknown>[]): Promise<DedupClusterMember[]> {
  const urls = await resolveMediaUrls(rows);
  return rows.map((row) => ({
    media_asset_id: String(row.media_asset_id),
    asset: mapMediaAsset(row, urls),
    variant: row.variant as DedupMemberVariant,
    similarity: typeof row.similarity === 'number' ? row.similarity : null,
    decision: (row.decision || 'undecided') as DedupMemberDecision,
  }));
}
