import type { MediaAsset } from './media';

export type DedupTier = 'exact' | 'near' | 'similar';
export type DedupClusterStatus = 'open' | 'resolved' | 'dismissed';
export type ClusterResolution = 'keep_one' | 'keep_all' | 'not_duplicate';
export type DedupMemberVariant = 'canonical' | 'exact_bytes' | 'phash_near' | 'scene_similar';
export type DedupMemberDecision = 'keep' | 'remove' | 'undecided';

export interface DedupClusterMember {
  media_asset_id: string;
  asset: MediaAsset;
  variant: DedupMemberVariant;
  similarity: number | null;
  decision: DedupMemberDecision;
}

export interface DedupCluster {
  id: string;
  /** Builder semantics version. Open clusters are rebuilt when this is stale. */
  build_version: number;
  canonical_media_asset_id: string | null;
  tier: DedupTier;
  status: DedupClusterStatus;
  resolution: ClusterResolution | null;
  method_summary: Record<string, number>;
  member_count: number;
  estimated_reclaim_bytes: number;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
  members?: DedupClusterMember[];
}

export interface DedupWorkbenchSummary {
  counts_by_tier: Record<DedupTier, number>;
  attention_count: number;
  total_estimated_reclaim_bytes: number;
  last_built_at: string | null;
}

export interface BatchResolveInput {
  cluster_ids: string[];
  resolution: ClusterResolution;
}

export interface BatchResolveReport {
  resolved: Array<{ cluster_id: string; removed_asset_ids: string[]; reclaimed_bytes: number }>;
  skipped: Array<{ cluster_id: string; code: string; protected?: unknown[] }>;
  removed_asset_ids: string[];
  total_reclaimed_bytes: number;
}
