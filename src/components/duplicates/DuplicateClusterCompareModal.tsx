'use client';

import { DuplicateCompareModal } from '@/components/review/DuplicateCompareModal';
import type { DedupCluster } from '@/types/dedup';

export function DuplicateClusterCompareModal({ cluster, isOpen, onClose, onResolve }: { cluster: DedupCluster | null; isOpen: boolean; onClose: () => void; onResolve: (resolution: 'keep_one' | 'keep_all', keepAssetId?: string, removeAssetIds?: string[]) => void }) {
  if (!cluster?.members?.length) return null;
  const current = cluster.members.find((member) => member.media_asset_id === cluster.canonical_media_asset_id) || cluster.members[0];
  const matched = cluster.members.filter((member) => member.media_asset_id !== current.media_asset_id).map((member) => member.asset);
  return <DuplicateCompareModal
    isOpen={isOpen}
    onClose={onClose}
    currentAsset={current.asset}
    matchedAssets={matched}
    similarity={cluster.members.find((member) => member.media_asset_id !== current.media_asset_id)?.similarity || undefined}
    onReplaceOld={(ids) => onResolve('keep_one', current.media_asset_id, ids)}
    onKeepBoth={() => onResolve('keep_all')}
    onDropNew={() => {
      const keepId = matched[0]?.id;
      onResolve('keep_one', keepId, keepId ? cluster.members?.filter((member) => member.media_asset_id !== keepId).map((member) => member.media_asset_id) : undefined);
    }}
  />;
}
