'use client';

import type { DedupClusterMember } from '@/types/dedup';
import { cn, formatBytes } from '@/lib/utils';
import { UsageProtectionBadge } from './UsageProtectionBadge';

export function DuplicateClusterMemberTile({ member, canonical, selectable = false, selectedForRemoval = false, onToggleRemoval }: { member: DedupClusterMember; canonical: boolean; selectable?: boolean; selectedForRemoval?: boolean; onToggleRemoval?: (selected: boolean) => void }) {
  const asset = member.asset;
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-xl border bg-surface', canonical ? 'border-verity ring-1 ring-verity/20' : 'border-border')}>
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-2">
        {asset.thumbnail_url ? <img src={asset.thumbnail_url} alt={asset.title || asset.sku || 'Ảnh'} className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-xs text-text-3">Không có preview</div>}
        {canonical && <span className="absolute left-2 top-2 rounded-full bg-verity px-2 py-1 text-[10px] font-bold text-white">Giữ lại</span>}
        {selectable && <input type="checkbox" aria-label="Chọn asset để đưa vào thùng rác" checked={selectedForRemoval} onChange={(event) => onToggleRemoval?.(event.target.checked)} className="absolute right-2 top-2 h-5 w-5 accent-verity" />}
      </div>
      <div className="space-y-1.5 p-2.5">
        <p className="truncate text-[12px] font-semibold text-text-1" title={asset.title}>{asset.title || asset.sku || asset.id}</p>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] text-text-3">
          <span>Độ phân giải <strong className="font-semibold text-text-2">{asset.dimensions.width}×{asset.dimensions.height}</strong></span>
          <span className="text-right">Dung lượng <strong className="font-semibold text-text-2">{formatBytes(asset.dimensions.size_bytes)}</strong></span>
          <span>Quyền <strong className="font-semibold text-text-2">{asset.permission === 'public' ? 'Public' : 'Internal'}</strong></span>
          <span className="text-right">Sử dụng <strong className="font-semibold text-text-2">{asset.usage_count || asset.usages?.length || 0}</strong></span>
        </div>
        <UsageProtectionBadge asset={asset} />
      </div>
    </div>
  );
}
