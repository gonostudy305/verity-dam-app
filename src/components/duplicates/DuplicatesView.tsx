'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw, SearchX } from 'lucide-react';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { useToast } from '@/components/common/Toast';
import type { DedupCluster, DedupTier, DedupWorkbenchSummary } from '@/types/dedup';
import { formatBytes } from '@/lib/utils';
import { DuplicateClusterCard } from './DuplicateClusterCard';
import { ClusterResolveConfirmDialog } from './ClusterResolveConfirmDialog';
import { DuplicatesBulkBar } from './DuplicatesBulkBar';
import { BatchResolveResultPanel } from './BatchResolveResultPanel';
import { DuplicateClusterReviewPanel } from './DuplicateClusterReviewPanel';
import type { BatchResolveReport } from '@/types/dedup';

interface ListResponse { data: { clusters: DedupCluster[]; total: number } & DedupWorkbenchSummary }
interface RebuildResponse {
  data: {
    clustersOpen: number;
    clustersCreated: number;
    clustersRemoved: number;
    suppressedSkipped: number;
  };
}
type Workspace = 'duplicates' | 'similar';
type DuplicateTier = Exclude<DedupTier, 'similar'>;

export function DuplicatesView() {
  const { showToast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const restoreClusterId = searchParams.get('cluster');
  const [clusters, setClusters] = useState<DedupCluster[]>([]);
  const [summary, setSummary] = useState<DedupWorkbenchSummary>({ counts_by_tier: { exact: 0, near: 0, similar: 0 }, attention_count: 0, total_estimated_reclaim_bytes: 0, last_built_at: null });
  const [workspace, setWorkspace] = useState<Workspace>(() => searchParams.get('workspace') === 'similar' ? 'similar' : 'duplicates');
  const [tier, setTier] = useState<DuplicateTier | 'all'>(() => {
    const value = searchParams.get('tier');
    return value === 'exact' || value === 'near' ? value : 'all';
  });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ cluster: DedupCluster; resolution: 'keep_one' | 'keep_all' | 'not_duplicate'; keepAssetId?: string; removeAssetIds?: string[] } | null>(null);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [undoClusterId, setUndoClusterId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchReport, setBatchReport] = useState<BatchResolveReport | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<DedupCluster | null>(null);
  const loadGeneration = useRef(0);
  const restoredClusterRef = useRef<string | null>(null);

  const load = useCallback(async (): Promise<boolean> => {
    const requestGeneration = ++loadGeneration.current;
    setError(null);
    try {
      const params = new URLSearchParams({ status: 'open', limit: '100', scope: workspace });
      if (workspace === 'duplicates' && tier !== 'all') params.set('tier', tier);
      const response = await apiRequest<ListResponse>(`/api/dedup/clusters?${params.toString()}`);
      if (requestGeneration !== loadGeneration.current) return false;
      setClusters(response.data.clusters); setSummary(response.data);
      return true;
    } catch (err) {
      if (requestGeneration !== loadGeneration.current) return false;
      setError(err instanceof ClientApiError && err.status === 403 ? 'Bạn cần quyền Reviewer để xem kho ảnh trùng.' : 'Không thể tải danh sách ảnh trùng.');
      return false;
    } finally {
      if (requestGeneration === loadGeneration.current) setLoading(false);
    }
  }, [tier, workspace]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (loading || !restoreClusterId || restoredClusterRef.current === restoreClusterId) return;
    const cluster = clusters.find((item) => item.id === restoreClusterId);
    if (!cluster) return;
    restoredClusterRef.current = restoreClusterId;
    setSelectedCluster(cluster);
  }, [clusters, loading, restoreClusterId]);

  const rescan = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await apiRequest<RebuildResponse>('/api/dedup/clusters/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const loaded = await load();
      if (!loaded) return;
      const { clustersCreated, clustersRemoved, clustersOpen } = response.data;
      const changed = clustersCreated + clustersRemoved;
      showToast(
        changed > 0
          ? `Đã quét lại: thêm ${clustersCreated}, loại ${clustersRemoved} nhóm. Còn ${clustersOpen} nhóm cần xử lý.`
          : `Đã quét lại. Không có thay đổi mới; còn ${clustersOpen} nhóm cần xử lý.`,
        'success',
      );
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : 'Không thể quét lại nhóm ảnh.');
    } finally {
      setRefreshing(false);
    }
  }, [load, refreshing, showToast]);

  const changeWorkspace = (next: Workspace) => {
    setWorkspace(next); setTier('all'); setSelectedIds(new Set()); setBatchReport(null);
  };

  const selectedClusterIndex = selectedCluster
    ? clusters.findIndex((c) => c.id === selectedCluster.id)
    : -1;

  const handleNavigateCluster = (direction: 'next' | 'prev') => {
    if (selectedClusterIndex === -1) return;
    const targetIndex = direction === 'next' ? selectedClusterIndex + 1 : selectedClusterIndex - 1;
    if (targetIndex >= 0 && targetIndex < clusters.length) {
      setSelectedCluster(clusters[targetIndex]);
    }
  };

  const openAssetInLibrary = useCallback((assetId: string) => {
    if (!selectedCluster) return;
    const returnParams = new URLSearchParams({
      workspace,
      cluster: selectedCluster.id,
    });
    if (workspace === 'duplicates' && tier !== 'all') returnParams.set('tier', tier);
    window.history.replaceState(window.history.state, '', `/duplicates?${returnParams.toString()}`);
    router.push(`/library?asset=${encodeURIComponent(assetId)}`);
  }, [router, selectedCluster, tier, workspace]);

  const handleQuickResolve = (cluster: DedupCluster) => {
    const members = cluster.members || [];
    const canonicalId = cluster.canonical_media_asset_id || members[0]?.media_asset_id;
    const removeAssetIds = members
      .filter((m) => m.media_asset_id !== canonicalId)
      .map((m) => m.media_asset_id);
    setAction({
      cluster,
      resolution: 'keep_one',
      keepAssetId: canonicalId,
      removeAssetIds,
    });
    setActionError(null);
    setForceConfirm(false);
    setConfirmationText('');
  };

  const resolve = async () => {
    if (!action) return;
    setBusyId(action.cluster.id); setActionError(null);
    try {
      const canonical = action.cluster.canonical_media_asset_id || action.cluster.members?.[0]?.media_asset_id;
      await apiRequest(`/api/dedup/clusters/${action.cluster.id}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: action.resolution, ...(action.resolution === 'keep_one' ? { keep_asset_id: action.keepAssetId || canonical, remove_asset_ids: action.removeAssetIds } : {}), force_confirm: forceConfirm && confirmationText === 'DUYỆT' }),
      });

      // If review modal was open for this cluster, auto-advance to next cluster if available
      if (selectedCluster && selectedCluster.id === action.cluster.id) {
        const remaining = clusters.filter((c) => c.id !== action.cluster.id);
        const currIdx = clusters.findIndex((c) => c.id === action.cluster.id);
        const nextCluster = remaining[currIdx] || remaining[currIdx - 1] || null;
        setSelectedCluster(nextCluster);
      }

      setAction(null); setForceConfirm(false); setConfirmationText(''); await load();
      setUndoClusterId(action.cluster.id);
      showToast('Đã xử lý nhóm ảnh. Asset bị soft-delete vẫn có thể hoàn tác.', 'success');
    } catch (err) {
      if (err instanceof ClientApiError && err.code === 'PROTECTED_ASSETS') {
        const protectedItems = Array.isArray(err.details) ? err.details : [];
        const detail = protectedItems.map((item) => {
          if (!item || typeof item !== 'object') return '';
          const value = item as { title?: unknown; reasons?: unknown };
          const reasons = Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === 'string').join(', ') : '';
          return [typeof value.title === 'string' ? value.title : 'Asset', reasons].filter(Boolean).join(': ');
        }).filter(Boolean).join(' · ');
        setForceConfirm(true); setConfirmationText(''); setActionError(detail || null);
      } else setActionError(err instanceof Error ? err.message : 'Không thể xử lý nhóm ảnh.');
    } finally { setBusyId(null); }
  };

  const resolveBatch = async (resolution: 'keep_all' | 'not_duplicate') => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    const verb = resolution === 'keep_all' ? 'giữ nguyên tất cả ảnh trong' : 'đánh dấu không phải ảnh trùng cho';
    if (!window.confirm(`Bạn sắp ${verb} ${ids.length} nhóm. Không có asset nào bị đưa vào thùng rác.`)) return;
    setBatchBusy(true); setError(null);
    try {
      const response = await apiRequest<{ data: BatchResolveReport }>('/api/dedup/clusters/batch-resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cluster_ids: ids, resolution }) });
      setBatchReport(response.data); setSelectedIds(new Set()); await load();
      showToast(`Đã xử lý ${response.data.resolved.length} nhóm; bỏ qua ${response.data.skipped.length}.`, 'success');
    } catch (err) { setError(err instanceof ClientApiError ? err.message : 'Không thể xử lý hàng loạt.'); }
    finally { setBatchBusy(false); }
  };

  const selectAllExact = () => setSelectedIds(new Set(clusters.filter((cluster) => cluster.tier === 'exact').map((cluster) => cluster.id)));
  const duplicateCount = summary.counts_by_tier.exact + summary.counts_by_tier.near;
  const currentCount = workspace === 'similar' ? summary.counts_by_tier.similar : duplicateCount;

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 p-3 pb-24 sm:gap-5 sm:p-6 lg:p-8">
      <section aria-labelledby="duplicates-workbench-heading" className="rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <h2 id="duplicates-workbench-heading" className="truncate text-base font-bold text-text-1 sm:text-lg">Ảnh trùng</h2>
            <span className="shrink-0 text-[11px] text-text-3">{currentCount} nhóm</span>
          </div>
          <button type="button" onClick={() => void rescan()} disabled={refreshing} className="inline-flex min-h-10 min-w-10 items-center justify-center gap-2 rounded-xl border border-border px-2.5 py-2 text-[12px] font-semibold text-text-2 hover:bg-hover disabled:opacity-50 sm:px-3" aria-label={refreshing ? 'Đang quét lại' : 'Quét lại'} title={refreshing ? 'Đang quét lại' : 'Quét lại'}><RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /><span className="hidden sm:inline">{refreshing ? 'Đang quét…' : 'Quét lại'}</span></button>
        </div>

        <div role="tablist" aria-label="Loại ảnh cần xem" className="mt-3 flex w-full max-w-full rounded-xl bg-surface-2 p-1 sm:w-fit">
          <button type="button" role="tab" aria-selected={workspace === 'duplicates'} onClick={() => changeWorkspace('duplicates')} className={`min-h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-xs font-bold transition sm:flex-initial ${workspace === 'duplicates' ? 'bg-surface text-verity-fg shadow-sm' : 'text-text-3 hover:text-text-1'}`}>Ảnh trùng <span className="ml-1 tabular-nums">{duplicateCount}</span></button>
          <button type="button" role="tab" aria-selected={workspace === 'similar'} onClick={() => changeWorkspace('similar')} className={`min-h-10 flex-1 whitespace-nowrap rounded-lg px-3 text-xs font-bold transition sm:flex-initial ${workspace === 'similar' ? 'bg-surface text-verity-fg shadow-sm' : 'text-text-3 hover:text-text-1'}`}>Ảnh tương tự <span className="ml-1 tabular-nums">{summary.counts_by_tier.similar}</span></button>
        </div>

        {workspace === 'duplicates' && <div className="mt-3 flex max-w-full items-center gap-2 overflow-x-auto pb-1" aria-label="Lọc ảnh trùng">
          {([['all', 'Tất cả'], ['exact', 'Bản sao chính xác'], ['near', 'Gần trùng']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => { setTier(value); setSelectedIds(new Set()); }} aria-pressed={tier === value} className={`min-h-10 rounded-full border px-3 text-[11px] font-semibold transition ${tier === value ? 'border-verity bg-verity-soft text-verity-fg' : 'border-border text-text-2 hover:bg-hover'}`}>{label}{value !== 'all' && <span className="ml-1.5 tabular-nums text-text-3">{summary.counts_by_tier[value]}</span>}</button>)}
        </div>}

        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border-subtle pt-2 text-[11px] text-text-3">
          <p className="min-w-0 truncate" title={summary.last_built_at ? `Cập nhật ${new Date(summary.last_built_at).toLocaleString('vi-VN')}` : undefined}>
            {workspace === 'duplicates' ? `Có thể thu hồi ${formatBytes(summary.total_estimated_reclaim_bytes)}` : 'Chỉ so sánh'}
            {summary.last_built_at ? ` · ${new Date(summary.last_built_at).toLocaleTimeString('vi-VN')}` : ''}
          </p>
          {workspace === 'duplicates' && <button type="button" onClick={selectAllExact} className="min-h-9 shrink-0 px-1 text-[11px] font-semibold text-verity-fg hover:underline">Chọn bản sao chính xác</button>}
        </div>
      </section>
      {error && <div role="alert" className="rounded-xl border border-bad/20 bg-bad-soft p-3 text-[12px] text-bad">{error}</div>}
      {undoClusterId && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-good/20 bg-good-soft px-3 py-2 text-xs text-good"><div><p>Đã xử lý nhóm. Asset bị soft-delete vẫn có thể hoàn tác.</p><p className="mt-0.5 text-[10px] text-text-3">Hoàn tác chỉ khôi phục asset; ingest job đã huỷ không tự chạy lại.</p></div><button type="button" onClick={async () => { try { await apiRequest(`/api/dedup/clusters/${undoClusterId}/undo`, { method: 'POST' }); setUndoClusterId(null); await load(); } catch { setError('Không thể hoàn tác nhóm ảnh.'); } }} className="min-h-10 font-bold underline">Hoàn tác</button></div>}
      {batchReport && <BatchResolveResultPanel report={batchReport} onUndo={async (clusterId) => { try { await apiRequest(`/api/dedup/clusters/${clusterId}/undo`, { method: 'POST' }); setBatchReport(null); await load(); } catch { setError('Không thể hoàn tác nhóm ảnh.'); } }} />}
      {loading ? <div className="grid min-h-48 place-items-center text-[13px] text-text-3">Đang tải nhóm ảnh…</div> : clusters.length === 0 ? <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-border p-8 text-center"><SearchX className="h-8 w-8 text-text-3" /><p className="mt-3 text-sm font-semibold text-text-1">Không có nhóm nào trong bộ lọc này</p><p className="mt-1 text-xs text-text-3">Khi worker tạo evidence mới, hãy bấm Quét lại.</p></div> : <div className="grid gap-4">{clusters.map((cluster) => <DuplicateClusterCard key={cluster.id} cluster={cluster} selected={selectedIds.has(cluster.id)} onSelect={(selected) => setSelectedIds((current) => { const next = new Set(current); if (selected) next.add(cluster.id); else next.delete(cluster.id); return next; })} onOpen={() => setSelectedCluster(cluster)} onQuickResolve={() => handleQuickResolve(cluster)} />)}</div>}
      {selectedIds.size > 0 && <DuplicatesBulkBar count={selectedIds.size} onClear={() => setSelectedIds(new Set())} onResolve={(resolution) => void resolveBatch(resolution)} busy={batchBusy} />}
      <ClusterResolveConfirmDialog cluster={action?.cluster || null} resolution={action?.resolution || null} keepAssetId={action?.keepAssetId} removeAssetIds={action?.removeAssetIds} forceConfirm={forceConfirm} confirmationText={confirmationText} onConfirmationTextChange={setConfirmationText} onConfirm={() => void resolve()} onClose={() => { if (!busyId) setAction(null); }} busy={Boolean(busyId)} error={actionError} />
      {selectedCluster && (
        <DuplicateClusterReviewPanel
          cluster={selectedCluster}
          currentIndex={selectedClusterIndex >= 0 ? selectedClusterIndex : undefined}
          totalClusters={clusters.length}
          onNavigate={handleNavigateCluster}
          onClose={() => {
            setSelectedCluster(null);
            if (restoreClusterId) router.replace('/duplicates');
          }}
          onOpenAsset={openAssetInLibrary}
          onResolve={(resolution, keepAssetId, removeAssetIds) => {
            setAction({ cluster: selectedCluster, resolution, keepAssetId, removeAssetIds });
            setActionError(null);
            setForceConfirm(false);
            setConfirmationText('');
          }}
        />
      )}
    </div>
  );
}
