'use client';

import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  ExternalLink,
  FileWarning,
  Maximize2,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DedupCluster, DedupClusterMember } from '@/types/dedup';
import { formatBytes, cn } from '@/lib/utils';
import { DuplicateTierBadge } from './DuplicateTierBadge';

interface DuplicateClusterReviewPanelProps {
  cluster: DedupCluster;
  currentIndex?: number;
  totalClusters?: number;
  onClose: () => void;
  onResolve: (
    resolution: 'keep_one' | 'keep_all' | 'not_duplicate',
    keepAssetId?: string,
    removeAssetIds?: string[]
  ) => void;
  onNavigate?: (direction: 'next' | 'prev') => void;
  onOpenAsset?: (assetId: string) => void;
}

function isProtected(member: DedupClusterMember) {
  return (
    member.asset.usage_count > 0 ||
    Boolean(member.asset.usages?.length) ||
    member.asset.publish_status === 'published' ||
    Boolean(member.asset.published_at)
  );
}

function memberName(member: DedupClusterMember) {
  return member.asset.title || member.asset.sku || member.asset.id;
}

function ReviewMember({
  member,
  canonical,
  selectedForRemoval,
  isBestResolution,
  onSelectCanonical,
  onToggleRemoval,
  onZoom,
  onOpenInLibrary,
  allowRemoval,
}: {
  member: DedupClusterMember;
  canonical: boolean;
  selectedForRemoval: boolean;
  isBestResolution: boolean;
  onSelectCanonical: () => void;
  onToggleRemoval: (selected: boolean) => void;
  onZoom: () => void;
  onOpenInLibrary?: () => void;
  allowRemoval: boolean;
}) {
  const protectedAsset = isProtected(member);
  const title = memberName(member);
  const dims = member.asset.dimensions;
  const hasDimensions = dims && dims.width > 0 && dims.height > 0;
  const keywordsCount = member.asset.keywords?.length || 0;
  const previewUrl = member.asset.thumbnail_url || member.asset.file_url;

  return (
    <article
      className={cn(
        'overflow-hidden rounded-2xl border bg-surface transition-all flex flex-col',
        canonical
          ? 'border-emerald-500 ring-2 ring-emerald-500/20 shadow-md'
          : selectedForRemoval
            ? 'border-red-300 dark:border-red-900/40 bg-red-50/15 dark:bg-red-950/10'
            : 'border-border'
      )}
    >
      {/* Photo Container with Object-Contain & Zoom Trigger */}
      <div
        className="relative aspect-[16/10] sm:aspect-[4/3] max-h-[360px] overflow-hidden bg-zinc-950/5 dark:bg-zinc-950/40 group cursor-pointer"
        onClick={onZoom}
        title="Nhấp để xem ảnh phóng to đầy đủ"
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={title}
            className="h-full w-full object-contain transition group-hover:scale-[1.01]"
            loading="lazy"
          />
        ) : (
          <div className="grid h-full place-items-center text-xs text-text-3">
            Không có ảnh preview
          </div>
        )}

        {/* Floating Badges */}
        <div className="absolute inset-x-2.5 top-2.5 flex items-start justify-between gap-1.5 pointer-events-none">
          {canonical ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-bold text-white shadow-sm">
              <Check className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" />
              Ảnh sẽ giữ lại
            </span>
          ) : selectedForRemoval ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold text-white shadow-sm">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Sẽ đưa vào thùng rác
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-zinc-600 px-2.5 py-1 text-xs font-bold text-white shadow-sm">
              Giữ lại (không xóa)
            </span>
          )}

          <div className="flex items-center gap-1">
            {protectedAsset && (
              <span className="rounded-full bg-amber-500 text-white px-2 py-0.5 text-[10.5px] font-bold shadow-xs flex items-center gap-1">
                <ShieldAlert className="h-3 w-3" /> Có ràng buộc
              </span>
            )}
            <span className="opacity-0 group-hover:opacity-100 transition rounded-full bg-black/60 text-white p-1 backdrop-blur-xs">
              <Maximize2 className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      </div>

      {/* Info & Comparison Metadata */}
      <div className="p-3.5 flex-1 flex flex-col justify-between gap-3">
        <div className="space-y-2">
          {/* Title & SKU */}
          <div>
            <p className="font-bold text-xs sm:text-sm text-text-1 truncate" title={title}>
              {title}
            </p>
            <p className="text-[11px] text-text-3 font-mono mt-0.5 truncate">
              {member.asset.sku ? (
                <span className="font-semibold text-text-2">SKU: {member.asset.sku}</span>
              ) : (
                'Chưa có SKU'
              )}
              {member.asset.category ? ` · ${member.asset.category}` : ''}
            </p>
          </div>

          {/* Quick Specs Row */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2 font-mono">
            <span className="font-semibold text-text-1">
              {hasDimensions ? `${dims.width} × ${dims.height}` : 'Chưa rõ kích thước'}
            </span>
            <span className="text-text-disabled">·</span>
            <span>{formatBytes(dims?.size_bytes || 0)}</span>
            {keywordsCount > 0 && (
              <>
                <span className="text-text-disabled">·</span>
                <span className="font-sans text-purple-600 dark:text-purple-400 font-medium">
                  {keywordsCount} tags AI
                </span>
              </>
            )}
            {member.asset.suggested_caption && (
              <>
                <span className="text-text-disabled">·</span>
                <span className="font-sans text-blue-600 dark:text-blue-400 font-medium">
                  Có caption
                </span>
              </>
            )}
          </div>

          {/* Highlights & Protection notes */}
          <div className="flex flex-wrap gap-1.5 items-center pt-0.5">
            {isBestResolution && hasDimensions && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 text-[10.5px] font-semibold">
                <Sparkles className="h-3 w-3" /> Nét nhất ({dims.width}×{dims.height})
              </span>
            )}
            {protectedAsset && (
              <span className="text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                ⚠️ {member.asset.publish_status === 'published' ? 'Đã xuất bản' : 'Đang sử dụng trên bài viết'}
              </span>
            )}
          </div>
        </div>

        {/* Action Selector */}
        <div className="pt-2 border-t border-border-subtle">
          {canonical ? (
            <div className="space-y-2">
              <div className="flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/40 px-3 py-2 text-xs font-bold text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                <span>Đang chọn giữ ảnh này</span>
              </div>
              {onOpenInLibrary && (
                <button type="button" onClick={onOpenInLibrary} className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-[11px] font-semibold text-text-2 transition hover:bg-hover hover:text-text-1 cursor-pointer">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Mở đúng ảnh trong Library
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onSelectCanonical}
                  className="flex-1 min-h-10 inline-flex items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-xs font-bold text-text-2 hover:bg-hover hover:border-border-strong hover:text-text-1 transition cursor-pointer"
                >
                  <span>Chọn giữ ảnh này</span>
                </button>

                {allowRemoval && (
                  <label className="min-h-10 inline-flex items-center gap-1.5 rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/80 dark:bg-red-950/20 px-3 py-2 text-xs font-bold text-red-700 dark:text-red-400 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={selectedForRemoval}
                      onChange={(event) => onToggleRemoval(event.target.checked)}
                      className="h-4 w-4 accent-red-600 rounded cursor-pointer"
                    />
                    <span>Xóa</span>
                  </label>
                )}
              </div>
              {onOpenInLibrary && (
                <button type="button" onClick={onOpenInLibrary} className="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-[11px] font-semibold text-text-2 transition hover:bg-hover hover:text-text-1 cursor-pointer">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Mở đúng ảnh trong Library
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function DuplicateClusterReviewPanel({
  cluster,
  currentIndex,
  totalClusters,
  onClose,
  onResolve,
  onNavigate,
  onOpenAsset,
}: DuplicateClusterReviewPanelProps) {
  const members = cluster.members || [];
  const suggestedCanonicalId =
    cluster.canonical_media_asset_id || members[0]?.media_asset_id || '';
  const [canonicalId, setCanonicalId] = useState(suggestedCanonicalId);
  const [removeIds, setRemoveIds] = useState<string[]>([]);
  const [showEvidence, setShowEvidence] = useState(false);
  const [zoomUrl, setZoomUrl] = useState<string | null>(null);
  const isSimilar = cluster.tier === 'similar';

  const removalMembers = useMemo(
    () => members.filter((member) => removeIds.includes(member.media_asset_id)),
    [members, removeIds]
  );
  const reclaimBytes = removalMembers.reduce(
    (total, member) => total + (member.asset.dimensions?.size_bytes || 0),
    0
  );

  // Compare resolutions strictly to avoid fake "Nét nhất" when all have same dimensions
  const { maxResolution, hasResolutionDiff } = useMemo(() => {
    const resolutions = members.map(
      (m) => (m.asset.dimensions?.width || 0) * (m.asset.dimensions?.height || 0)
    );
    const max = Math.max(...resolutions, 0);
    const min = Math.min(...resolutions, 0);
    return {
      maxResolution: max,
      hasResolutionDiff: max > min && max > 0,
    };
  }, [members]);

  // Karpathy Guideline: Auto-tick duplicate removals on mount or cluster change
  useEffect(() => {
    const nextSuggested =
      cluster.canonical_media_asset_id || cluster.members?.[0]?.media_asset_id || '';
    setCanonicalId(nextSuggested);
    if (cluster.tier !== 'similar') {
      const autoRemovals = (cluster.members || [])
        .filter((m) => m.media_asset_id !== nextSuggested)
        .map((m) => m.media_asset_id);
      setRemoveIds(autoRemovals);
    } else {
      setRemoveIds([]);
    }
    setShowEvidence(false);
    setZoomUrl(null);
  }, [cluster.id, cluster.canonical_media_asset_id, cluster.members, cluster.tier]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (zoomUrl) {
        if (e.key === 'Escape') setZoomUrl(null);
        return;
      }
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowRight') {
        onNavigate?.('next');
      } else if (e.key === 'ArrowLeft') {
        onNavigate?.('prev');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate, zoomUrl]);

  const chooseCanonical = (id: string) => {
    setCanonicalId(id);
    if (!isSimilar) {
      setRemoveIds(
        members.filter((m) => m.media_asset_id !== id).map((m) => m.media_asset_id)
      );
    } else {
      setRemoveIds((current) => current.filter((removeId) => removeId !== id));
    }
  };

  const toggleRemoval = (id: string, selected: boolean) => {
    setRemoveIds((current) =>
      selected
        ? [...new Set([...current, id])]
        : current.filter((removeId) => removeId !== id)
    );
  };

  const selectAllRemovals = () => {
    setRemoveIds(
      members.filter((m) => m.media_asset_id !== canonicalId).map((m) => m.media_asset_id)
    );
  };

  const clearAllRemovals = () => {
    setRemoveIds([]);
  };

  const hasProtectedRemovals = removeIds.some((id) =>
    members.some((member) => member.media_asset_id === id && isProtected(member))
  );

  const hasNavigation = typeof totalClusters === 'number' && totalClusters > 1;

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 p-0 sm:p-4 backdrop-blur-xs flex items-center justify-center animate-fadeIn">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Xem và xử lý nhóm ảnh trùng"
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden bg-surface shadow-2xl sm:h-auto sm:max-h-[92vh] sm:rounded-3xl sm:border sm:border-border"
      >
        {/* Modal Header */}
        <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3.5 sm:px-6 shrink-0 bg-surface-2/40">
          <div className="flex items-center gap-3 min-w-0">
            <DuplicateTierBadge tier={cluster.tier} />
            <div className="min-w-0">
              <h2 className="text-base font-bold text-text-1 truncate sm:text-lg">
                {isSimilar ? 'So sánh ảnh tương tự' : 'Chọn ảnh chuẩn để giữ lại'}
              </h2>
              <p className="text-[11.5px] text-text-3 truncate">
                {isSimilar
                  ? 'Gợi ý cùng cảnh hoặc sản phẩm, không tự động suy ra ảnh trùng.'
                  : `Đã chọn sẵn ảnh chuẩn. Bấm xóa để chuyển ${removeIds.length} ảnh trùng vào thùng rác.`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Continuous Review Navigation */}
            {hasNavigation && (
              <div className="flex items-center gap-1.5 mr-1">
                <button
                  type="button"
                  onClick={() => onNavigate?.('prev')}
                  disabled={!currentIndex || currentIndex <= 0}
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-xs font-semibold text-text-2 hover:bg-surface-2 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                  title="Nhóm trước (Phím ←)"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Trước</span>
                </button>
                <span className="font-mono text-xs font-bold text-text-1 px-1.5">
                  {(currentIndex ?? 0) + 1} / {totalClusters}
                </span>
                <button
                  type="button"
                  onClick={() => onNavigate?.('next')}
                  disabled={
                    currentIndex === undefined || currentIndex >= totalClusters - 1
                  }
                  className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2 text-xs font-semibold text-text-2 hover:bg-surface-2 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
                  title="Nhóm tiếp theo (Phím →)"
                >
                  <span className="hidden sm:inline">Tiếp</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng nhóm ảnh"
              className="grid h-8.5 w-8.5 place-items-center rounded-xl text-text-3 hover:bg-hover hover:text-text-1 cursor-pointer"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Modal Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 space-y-4">
          {isSimilar && (
            <div className="flex items-start gap-2 rounded-2xl border border-verity/25 bg-verity-soft p-3 text-xs text-verity-fg">
              <FileWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>
                Đây là ảnh tương tự, không phải kết luận ảnh trùng. Hãy so sánh kỹ trước khi đưa ra quyết định.
              </p>
            </div>
          )}

          {/* Convenience selection controls for clusters with 3+ members */}
          {!isSimilar && members.length > 2 && (
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs font-semibold text-text-3">
                Nhóm {members.length} ảnh:
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllRemovals}
                  className="text-[11.5px] font-semibold text-verity hover:underline cursor-pointer"
                >
                  Chọn tất cả ảnh trùng để xóa
                </button>
                <span className="text-text-disabled">·</span>
                <button
                  type="button"
                  onClick={clearAllRemovals}
                  className="text-[11.5px] font-semibold text-text-3 hover:underline cursor-pointer"
                >
                  Bỏ chọn xóa
                </button>
              </div>
            </div>
          )}

          {/* Members Comparison Grid - Takes Full Width */}
          <div
            className={cn(
              'grid gap-4',
              members.length === 2
                ? 'sm:grid-cols-2'
                : 'sm:grid-cols-2 lg:grid-cols-3'
            )}
          >
            {members.map((member) => (
              <ReviewMember
                key={member.media_asset_id}
                member={member}
                canonical={member.media_asset_id === canonicalId}
                selectedForRemoval={removeIds.includes(member.media_asset_id)}
                isBestResolution={
                  hasResolutionDiff &&
                  (member.asset.dimensions?.width || 0) *
                    (member.asset.dimensions?.height || 0) ===
                    maxResolution
                }
                onSelectCanonical={() => chooseCanonical(member.media_asset_id)}
                onToggleRemoval={(selected) =>
                  toggleRemoval(member.media_asset_id, selected)
                }
                onZoom={() =>
                  setZoomUrl(member.asset.file_url || member.asset.thumbnail_url)
                }
                onOpenInLibrary={onOpenAsset ? () => onOpenAsset(member.media_asset_id) : undefined}
                allowRemoval={!isSimilar}
              />
            ))}
          </div>

          {/* Technical Evidence Collapsible */}
          <div className="rounded-xl border border-border bg-surface">
            <button
              type="button"
              onClick={() => setShowEvidence((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-xs font-bold text-text-3 hover:text-text-1 cursor-pointer"
            >
              <span className="inline-flex items-center gap-1.5">
                <FileWarning className="h-3.5 w-3.5 text-text-3" aria-hidden="true" />
                Chi tiết bằng chứng kỹ thuật ({Object.keys(cluster.method_summary).length} thuật toán)
              </span>
              {showEvidence ? (
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
            {showEvidence && (
              <div className="grid gap-2 border-t border-border-subtle p-3 text-[11px] text-text-3 sm:grid-cols-2">
                {Object.entries(cluster.method_summary).map(([method, count]) => (
                  <div key={method} className="rounded-lg bg-surface-2 px-2.5 py-1.5">
                    <strong className="font-semibold text-text-2">{method}</strong>: {count} cặp khớp
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer: Unified Action Bar */}
        <footer className="border-t border-border px-4 py-3.5 sm:px-6 bg-surface-2/50 shrink-0 flex flex-wrap items-center justify-between gap-3">
          {/* Status summary */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-2">
            {!isSimilar ? (
              <>
                <span>
                  Giữ: <strong>1</strong> · Xóa:{' '}
                  <strong className="text-red-600 dark:text-red-400">
                    {removeIds.length} ảnh
                  </strong>{' '}
                  ({formatBytes(reclaimBytes)})
                </span>
                {hasProtectedRemovals && (
                  <span className="text-amber-600 dark:text-amber-400 font-semibold flex items-center gap-1">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    Có ảnh đang dùng (sẽ cần gõ DUYỆT)
                  </span>
                )}
              </>
            ) : (
              <span className="inline-flex items-center text-text-3" title="Ảnh tương tự chỉ dùng để so sánh; không thể đưa vào thùng rác." aria-label="Chỉ dùng để so sánh">
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">Chỉ dùng để so sánh nội dung</span>
              </span>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => onResolve('not_duplicate')}
              className="min-h-10 w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-2 transition hover:bg-hover cursor-pointer sm:w-auto"
              title="Đánh dấu nhóm này không phải ảnh trùng"
            >
              Không phải ảnh trùng
            </button>

            <button
              type="button"
              onClick={() => onResolve('keep_all')}
              className="min-h-10 w-full rounded-xl border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-2 transition hover:bg-hover cursor-pointer sm:w-auto"
              title="Giữ lại tất cả ảnh trong nhóm"
            >
              Giữ cả nhóm
            </button>

            {!isSimilar && (
              <button
                type="button"
                onClick={() => onResolve('keep_one', canonicalId, removeIds)}
                disabled={!canonicalId || removeIds.length === 0}
                className={cn(
                  'inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold text-white shadow-sm transition cursor-pointer sm:w-auto',
                  removeIds.length > 0
                    ? 'bg-red-600 hover:bg-red-700 active:bg-red-800'
                    : 'bg-zinc-400 cursor-not-allowed opacity-50'
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>
                  {removeIds.length > 0
                    ? `Xóa ${removeIds.length} ảnh trùng`
                    : 'Chọn ảnh để xóa'}
                </span>
              </button>
            )}
          </div>
        </footer>
      </section>

      {/* Lightbox Modal for Full Image Inspection */}
      {zoomUrl && (
        <div
          className="fixed inset-0 z-[120] bg-black/90 p-4 flex flex-col items-center justify-center animate-fadeIn cursor-pointer"
          onClick={() => setZoomUrl(null)}
        >
          <button
            type="button"
            onClick={() => setZoomUrl(null)}
            className="absolute top-4 right-4 text-white hover:text-zinc-300 p-2 rounded-full bg-white/10 cursor-pointer"
            aria-label="Đóng phóng to"
          >
            <X className="h-6 w-6" />
          </button>
          <img
            src={zoomUrl}
            alt="Phóng to chi tiết"
            className="max-h-[92vh] max-w-[92vw] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
