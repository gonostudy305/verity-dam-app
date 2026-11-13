'use client';

import { ArrowRight, CheckCircle2, Eye, ShieldAlert, Sparkles } from 'lucide-react';
import type { DedupCluster } from '@/types/dedup';
import { formatBytes } from '@/lib/utils';
import { DuplicateTierBadge } from './DuplicateTierBadge';

interface DuplicateClusterCardProps {
  cluster: DedupCluster;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  onOpen?: () => void;
  onQuickResolve?: () => void;
}

function hasProtection(member: NonNullable<DedupCluster['members']>[number]) {
  return member.asset.usage_count > 0
    || Boolean(member.asset.usages?.length)
    || member.asset.publish_status === 'published'
    || Boolean(member.asset.published_at);
}

export function DuplicateClusterCard({ cluster, selected = false, onSelect, onOpen, onQuickResolve }: DuplicateClusterCardProps) {
  const members = cluster.members || [];
  const canonicalId = cluster.canonical_media_asset_id || members[0]?.media_asset_id;
  const batchSelectable = cluster.tier !== 'similar';
  const protectedCount = members.filter((member) => member.media_asset_id !== canonicalId && hasProtection(member)).length;
  const previewMembers = members.slice(0, 4);

  return (
    <article className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition hover:border-verity/45 hover:shadow-md">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle p-3 sm:p-4">
        <div className="flex min-w-0 items-start gap-3">
          {onSelect && batchSelectable && (
            <label className="-m-2 mt-0 flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg hover:bg-hover">
              <input
                type="checkbox"
                aria-label="Chọn cluster"
                checked={selected}
                onChange={(event) => onSelect(event.target.checked)}
                className="h-5 w-5 accent-verity"
              />
            </label>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <DuplicateTierBadge tier={cluster.tier} />
              <span className="text-[12px] font-semibold text-text-1">Nhóm {cluster.member_count} ảnh</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {onQuickResolve && cluster.tier !== 'similar' && (
            <button
              type="button"
              onClick={onQuickResolve}
              title="Dọn nhanh: Giữ ảnh chuẩn, đưa các ảnh trùng còn lại vào thùng rác"
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-red-200 bg-red-50/80 px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-100 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50 sm:flex-initial cursor-pointer"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Dọn nhanh 1-Click
            </button>
          )}
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-verity px-3 py-2 text-xs font-bold text-white transition hover:bg-verity/90 sm:flex-initial cursor-pointer"
          >
            {cluster.tier === 'similar' ? 'So sánh' : 'Xem nhóm'}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-2 p-3 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 sm:p-4">
        {previewMembers.map((member) => {
          const dims = member.asset.dimensions;
          const hasDims = dims && dims.width > 0 && dims.height > 0;
          return (
            <div key={member.media_asset_id} className="relative overflow-hidden rounded-xl border border-border bg-surface-2 flex flex-col justify-between">
              <div className="relative aspect-[4/3] overflow-hidden bg-black/5">
                {member.asset.thumbnail_url ? (
                  <img
                    src={member.asset.thumbnail_url}
                    alt={member.asset.title || member.asset.sku || 'Ảnh trong nhóm'}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-full place-items-center px-2 text-center text-[10px] text-text-3">Không có preview</div>
                )}
                {member.media_asset_id === canonicalId && (
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-verity px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                    Ảnh chuẩn
                  </span>
                )}
              </div>
              <div className="p-2 space-y-1">
                <p className="truncate text-[11px] font-semibold text-text-1" title={member.asset.title || member.asset.sku || member.asset.id}>
                  {member.asset.title || member.asset.sku || member.asset.id}
                </p>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-text-3 font-mono">
                  <span>{hasDims ? `${dims.width}×${dims.height}` : 'N/A'}</span>
                  <span>·</span>
                  <span>{formatBytes(dims?.size_bytes)}</span>
                  {member.asset.keywords && member.asset.keywords.length > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-verity font-sans font-medium">{member.asset.keywords.length} tags</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {members.length > previewMembers.length && (
          <div className="grid aspect-[4/3] place-items-center rounded-xl border border-dashed border-border bg-surface-2 px-3 text-center text-xs font-semibold text-text-3">
            +{members.length - previewMembers.length} ảnh khác
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-4 py-3 text-[11px] text-text-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {cluster.tier === 'similar' ? (
            <span className="inline-flex items-center text-text-3" title="Ảnh tương tự chỉ dùng để so sánh; không thể đưa vào thùng rác." aria-label="Chỉ dùng để so sánh">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Chỉ dùng để so sánh</span>
            </span>
          ) : (
            <span>Tối đa có thể giải phóng: <strong className="font-semibold text-text-2">{formatBytes(cluster.estimated_reclaim_bytes)}</strong></span>
          )}
          {protectedCount > 0 ? (
            <span className="inline-flex items-center gap-1 font-semibold text-warn">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
              {protectedCount} ảnh có ràng buộc
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-good">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Chưa thấy ràng buộc sử dụng
            </span>
          )}
        </div>
        <details className="group text-[11px]">
          <summary className="cursor-pointer list-none font-semibold text-text-3 hover:text-text-1 group-open:text-verity-fg">Chi tiết bằng chứng</summary>
          <div className="mt-2 max-w-xl rounded-lg bg-surface-2 px-3 py-2 text-right text-[10px] text-text-3">
            {Object.entries(cluster.method_summary).map(([method, count]) => `${method}: ${count}`).join(' · ') || 'Chưa có mô tả bằng chứng'}
          </div>
        </details>
      </footer>
    </article>
  );
}
