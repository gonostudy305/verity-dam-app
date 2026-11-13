'use client';

import { AlertTriangle, X } from 'lucide-react';
import type { ClusterResolution, DedupCluster } from '@/types/dedup';
import { formatBytes } from '@/lib/utils';

interface Props {
  cluster: DedupCluster | null;
  resolution: ClusterResolution | null;
  keepAssetId?: string;
  removeAssetIds?: string[];
  forceConfirm: boolean;
  confirmationText: string;
  onConfirmationTextChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
}

export function ClusterResolveConfirmDialog({ cluster, resolution, keepAssetId, removeAssetIds = [], forceConfirm, confirmationText, onConfirmationTextChange, onConfirm, onClose, busy, error }: Props) {
  if (!cluster || !resolution) return null;
  const removalMembers = cluster.members?.filter((member) => removeAssetIds.includes(member.media_asset_id)) || [];
  const keepMember = cluster.members?.find((member) => member.media_asset_id === keepAssetId);
  const removalBytes = removalMembers.reduce((total, member) => total + (member.asset.dimensions.size_bytes || 0), 0);
  const removalCount = resolution === 'keep_one' ? (removeAssetIds.length || Math.max(0, cluster.member_count - 1)) : 0;
  const needsType = forceConfirm;
  return <div className="fixed inset-0 z-[110] grid place-items-center bg-black/55 p-4">
    <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-warn-soft text-warn">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-1">
              {resolution === 'keep_one' ? 'Xác nhận dọn ảnh trùng' : 'Xác nhận quyết định nhóm ảnh'}
            </h2>
            <p className="mt-1 text-xs text-text-3">
              {resolution === 'keep_one'
                ? `Giữ 1 ảnh · Đưa ${removalCount} ảnh vào thùng rác · Có thể hoàn tác.`
                : resolution === 'keep_all'
                  ? 'Giữ nguyên tất cả ảnh và đánh dấu nhóm này đã xem.'
                  : 'Đánh dấu nhóm này không phải ảnh trùng để không hiện lại.'}
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-lg p-1 text-text-3 hover:bg-hover">
          <X className="h-4 w-4" />
        </button>
      </div>

      {resolution === 'keep_one' ? (
        <div className="mt-4 space-y-2 text-xs">
          <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-text-2">
            Đưa vào thùng rác: <strong>{removalCount} ảnh</strong> · <strong>{formatBytes(removalBytes > 0 ? removalBytes : cluster.estimated_reclaim_bytes)}</strong>
          </div>
          {keepMember && (
            <div className="rounded-xl border border-good/20 bg-good-soft px-3 py-2.5 text-good">
              <span className="font-semibold">Giữ lại: </span>
              <span className="font-bold text-text-1">{keepMember.asset.title || keepMember.asset.sku || keepMember.media_asset_id}</span>
            </div>
          )}
          {removalMembers.length > 0 && (
            <details className="rounded-xl border border-border-subtle px-3 py-2 text-text-2">
              <summary className="cursor-pointer font-semibold">Xem {removalMembers.length} ảnh sẽ xóa</summary>
              <ul className="mt-2 max-h-24 space-y-1 overflow-y-auto border-t border-border-subtle pt-2">
                {removalMembers.map((member) => (
                  <li key={member.media_asset_id} className="flex justify-between gap-2">
                    <span className="truncate">{member.asset.title || member.asset.sku || member.media_asset_id}</span>
                    <span className="shrink-0 text-text-3">{formatBytes(member.asset.dimensions.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <div className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-text-2">
          Không có asset nào bị xóa; thao tác chỉ cập nhật trạng thái nhóm.
        </div>
      )}

      {needsType && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold text-bad">Asset đang được sử dụng hoặc đã xuất bản. Gõ DUYỆT để tiếp tục.</p>
          <label htmlFor="duplicate-override-confirmation" className="sr-only">Nhập DUYỆT để xác nhận</label>
          <input
            id="duplicate-override-confirmation"
            autoFocus
            value={confirmationText}
            onChange={(event) => onConfirmationTextChange(event.target.value)}
            placeholder="Nhập DUYỆT"
            className="w-full rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm font-semibold text-text-1"
            aria-label="Nhập DUYỆT để xác nhận"
          />
        </div>
      )}
      {error && <p role="alert" className="mt-3 max-h-20 overflow-y-auto rounded-lg bg-bad-soft p-2 text-[11px] text-bad">Chi tiết: {error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-xl border border-border px-3 py-2 text-xs font-semibold text-text-2 hover:bg-hover">Huỷ</button>
        <button type="button" onClick={onConfirm} disabled={busy || (needsType && confirmationText !== 'DUYỆT')} className="rounded-xl bg-verity px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
          {busy ? 'Đang xử lý…' : 'Xác nhận'}
        </button>
      </div>
    </div>
  </div>;
}
