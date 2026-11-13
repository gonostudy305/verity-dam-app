'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { clsx } from '@/lib/clsx';
import { MediaAsset, ReviewQueueItem } from '@/types/media';
import { apiRequest } from '@/lib/client/api';

import { ImagePreviewArea } from './ImagePreviewArea';
import { MetadataForm } from './MetadataForm';
import { useToast } from '@/components/common/Toast';
import { CheckCircle2, Image as ImageIcon, ListChecks, Target } from 'lucide-react';
import { AccessibleTabPanel, AccessibleTabs } from '@/components/common/interaction-primitives';
import type { TaggableRole } from '@/lib/product-role';
import { useBatchGroups } from '@/hooks/useBatchGroups';
import { useBatchSelection } from '@/hooks/useBatchSelection';
import { BatchReviewForm } from './BatchReviewForm';
import { QuickBatchActionBar } from './QuickBatchActionBar';
import { ReviewGrid } from './ReviewGrid';
import { ReviewToolbar, type ReviewViewMode } from './ReviewToolbar';
import { ReviewBatchBar } from './ReviewBatchBar';
import { ReviewDecisionConfirm } from './ReviewDecisionConfirm';
import { ReviewColumnResizer } from './ReviewColumnResizer';
import { useResizableInspectorWidth } from '@/hooks/useResizableInspectorWidth';
import { TopbarPortal } from '@/components/layout/TopbarPortal';

interface ReviewViewProps {
  onQueueUpdate?: (count: number) => void;
}

interface ReviewQueueResponse {
  data: ReviewQueueItem[];
  total: number;
  next_cursor?: string | null;
  has_more?: boolean;
  mode?: 'demo';
}

interface PendingBatchDecision {
  decision: 'approved' | 'rejected' | 'skipped';
  patch?: Partial<MediaAsset>;
  corrections?: string[];
  referenceQueueId?: string;
  productLinks?: { sku: string; role: TaggableRole }[];
  patchFields?: string[];
}

const REVIEW_BATCH_SIZE = 50;
const REVIEW_PREFETCH_THRESHOLD = 10;

export function ReviewView({ onQueueUpdate }: ReviewViewProps) {
  const { showToast } = useToast();
  const searchParams = useSearchParams();
  const targetAssetId = searchParams?.get('assetId') || searchParams?.get('queueId') || searchParams?.get('id');

  const [activeTab, setActiveTab] = useState<'pending' | 'skipped'>('pending');

  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [reviewPanel, setReviewPanel] = useState<'image' | 'metadata'>('image');
  const [isCompactReview, setIsCompactReview] = useState(false);
  const [viewMode, setViewMode] = useState<ReviewViewMode>('focus');
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const [pendingBatchDecision, setPendingBatchDecision] = useState<PendingBatchDecision | null>(null);

  const batchGroups = useBatchGroups(queue);
  const batchSelection = useBatchSelection(queue);
  const inspector = useResizableInspectorWidth();

  const activeBatchGroup = React.useMemo(() => {
    if (batchSelection.selectionMode !== 'multi') return null;
    const selectedGroupKeys = batchGroups
      .filter((group) => group.items.some((item) => batchSelection.selectedIds.has(item.id)))
      .map((group) => group.key);
    if (selectedGroupKeys.length !== 1) return null;
    return batchGroups.find((group) => group.key === selectedGroupKeys[0]) || null;
  }, [batchGroups, batchSelection.selectedIds, batchSelection.selectionMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1119px)');
    const updateReviewLayout = () => setIsCompactReview(mediaQuery.matches);
    updateReviewLayout();
    mediaQuery.addEventListener?.('change', updateReviewLayout);
    return () => mediaQuery.removeEventListener?.('change', updateReviewLayout);
  }, []);

  // "Để sau" (skipped) items are a real, persisted review_queue.status --
  // this is a second, independent list, not a client-side rotation within
  // the pending queue (see backend/migrations/0003_native_media_schema.sql
  // and /api/review-queue/[id]/decision + /reopen).
  const [skippedItems, setSkippedItems] = useState<ReviewQueueItem[]>([]);
  const [skippedTotal, setSkippedTotal] = useState(0);
  const [skippedLoading, setSkippedLoading] = useState(true);
  const [skippedError, setSkippedError] = useState<string | null>(null);
  const [reopeningId, setReopeningId] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<ReviewQueueResponse>(`/api/review-queue?limit=${REVIEW_BATCH_SIZE}`);
      const items = response.data || [];
      setQueue(items);
      setPendingTotal(response.total ?? items.length);
      setNextCursor(response.next_cursor ?? null);
      let initialIdx = 0;
      if (targetAssetId && items.length > 0) {
        const found = items.findIndex(
          (item) => item.asset?.id === targetAssetId || item.id === targetAssetId
        );
        if (found !== -1) {
          initialIdx = found;
        }
      }
      setCurrentIndex(initialIdx);
      setIsDemoMode(response.mode === 'demo');
      onQueueUpdate?.(response.total);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải hàng chờ duyệt.');
      setQueue([]);
      setPendingTotal(0);
      setNextCursor(null);
      setIsDemoMode(false);
      onQueueUpdate?.(0);
    } finally {
      setLoading(false);
    }
  }, [onQueueUpdate, targetAssetId]);

  const loadNextQueuePage = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const response = await apiRequest<ReviewQueueResponse>(
        `/api/review-queue?limit=${REVIEW_BATCH_SIZE}&cursor=${encodeURIComponent(nextCursor)}`
      );
      setQueue((current) => [...current, ...(response.data || [])]);
      setPendingTotal(response.total ?? pendingTotal);
      setNextCursor(response.next_cursor ?? null);
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể tải thêm hàng chờ duyệt.', 'warn');
      setNextCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, pendingTotal, showToast]);

  const loadSkipped = useCallback(async () => {
    setSkippedLoading(true);
    setSkippedError(null);
    try {
      const response = await apiRequest<ReviewQueueResponse>('/api/review-queue?status=skipped&limit=100');
      const items = response.data || [];
      setSkippedItems(items);
      setSkippedTotal(response.total ?? items.length);
    } catch (requestError) {
      setSkippedError(requestError instanceof Error ? requestError.message : 'Không thể tải danh sách để sau.');
      setSkippedItems([]);
    } finally {
      setSkippedLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    void loadSkipped();
  }, [loadSkipped]);

  useEffect(() => {
    if (activeTab === 'skipped') void loadSkipped();
  }, [activeTab, loadSkipped]);

  useEffect(() => {
    if (targetAssetId && queue.length > 0) {
      const found = queue.findIndex(
        (item) => item.asset?.id === targetAssetId || item.id === targetAssetId
      );
      if (found !== -1) {
        setCurrentIndex(found);
      }
    }
  }, [targetAssetId, queue]);

  useEffect(() => {
    if (activeTab !== 'pending' || loading || loadingMore || !nextCursor) return;
    const targetIsLoaded = Boolean(targetAssetId && queue.some(
      (item) => item.asset?.id === targetAssetId || item.id === targetAssetId
    ));
    const nearEnd = queue.length - currentIndex <= REVIEW_PREFETCH_THRESHOLD;
    if ((!targetIsLoaded && Boolean(targetAssetId)) || nearEnd) void loadNextQueuePage();
  }, [activeTab, currentIndex, loadNextQueuePage, loading, loadingMore, nextCursor, queue, targetAssetId]);

  const currentItem = queue[currentIndex];
  const isQueueFinished = !loading && !loadingMore && !nextCursor && (currentIndex >= queue.length || queue.length === 0);
  const isWaitingForNextBatch = !loading && queue.length === 0 && (loadingMore || Boolean(nextCursor));

  const removeCurrentItem = () => {
    setQueue((current) => {
      const next = current.filter((_, index) => index !== currentIndex);
      setCurrentIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
      return next;
    });
    setPendingTotal((total) => {
      const nextTotal = Math.max(0, total - 1);
      onQueueUpdate?.(nextTotal);
      return nextTotal;
    });
  };

  const resolveCurrentItem = async (
    decision: 'approved' | 'rejected' | 'skipped',
    asset?: MediaAsset,
    corrections: string[] = [],
    replaceAssetIds?: string[],
    productLinks?: { sku: string; role: TaggableRole }[]
  ) => {
    if (!currentItem || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await apiRequest(`/api/review-queue/${currentItem.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          patch: decision === 'skipped' ? undefined : asset,
          corrections: decision === 'skipped' ? [] : corrections,
          replace_asset_ids: decision === 'skipped' ? undefined : replaceAssetIds,
          non_catalog: decision === 'skipped' ? undefined : (asset?.ai_flags?.non_catalog === true),
          promote_reference: decision === 'skipped' ? undefined : (asset?.promote_reference === true),
          needs_post_production: decision === 'skipped' ? undefined : (asset?.needs_post_production === true),
          product_links: decision === 'approved' && productLinks && productLinks.length > 0 ? productLinks : undefined,
        }),
      });
      if (decision === 'approved') {
        if (replaceAssetIds && replaceAssetIds.length > 0) {
          showToast('Đã duyệt ảnh mới và xóa ảnh trùng cũ trong kho', 'success');
        } else {
          showToast('Đã duyệt ảnh và lưu vào Thư viện', 'success');
        }
      } else if (decision === 'rejected') {
        showToast('Đã từ chối ảnh', 'warn');
      } else {
        showToast('Đã chuyển ảnh sang mục "Để sau"', 'info');

        setSkippedTotal((count) => count + 1);
      }
      removeCurrentItem();
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể lưu quyết định duyệt ảnh.', 'warn');
      if ((requestError as { status?: number })?.status === 409) void loadQueue();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = () => {
    void resolveCurrentItem('skipped');
  };

  const openFocusView = useCallback((item: ReviewQueueItem) => {
    const index = queue.findIndex((entry) => entry.id === item.id);
    if (index < 0) return;
    setCurrentIndex(index);
    setReturnFocusId(item.id);
    setViewMode('focus');
  }, [queue]);

  const resolveBatchItems = async (
    decision: 'approved' | 'rejected' | 'skipped',
    patch?: Partial<MediaAsset>,
    corrections: string[] = [],
    referenceQueueId?: string,
    productLinks?: { sku: string; role: TaggableRole }[],
    patchFields?: string[]
  ) => {
    if (batchSelection.selectedItems.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    const queueIds = batchSelection.selectedItems.map((item) => item.id);
    const count = queueIds.length;
    try {
      await apiRequest('/api/review-queue/batch-decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queue_ids: queueIds,
          decision,
          patch: decision === 'skipped' ? undefined : patch,
          patch_fields: decision === 'skipped' ? undefined : patchFields,
          corrections: decision === 'skipped' ? [] : corrections,
          reference_queue_id: referenceQueueId,
          non_catalog: decision === 'skipped' ? undefined : (patch?.ai_flags?.non_catalog === true),
          promote_reference: decision === 'skipped' ? undefined : (patch?.promote_reference === true),
          needs_post_production: decision === 'skipped'
            ? undefined
            : typeof patch?.needs_post_production === 'boolean'
              ? patch.needs_post_production
              : undefined,
          product_links: decision === 'approved' && productLinks && productLinks.length > 0 ? productLinks : undefined,
        }),
      });

      if (decision === 'approved') {
        showToast(`Đã duyệt ${count} ảnh vào Thư viện`, 'success');
      } else if (decision === 'rejected') {
        showToast(`Đã từ chối ${count} ảnh`, 'warn');
      } else {
        showToast(`Đã chuyển ${count} ảnh sang mục "Để sau"`, 'info');
        setSkippedTotal((prev) => prev + count);
      }

      const queueIdSet = new Set(queueIds);
      setQueue((current) => {
        const next = current.filter((item) => !queueIdSet.has(item.id));
        setCurrentIndex((index) => Math.min(index, Math.max(0, next.length - 1)));
        return next;
      });
      setPendingTotal((total) => {
        const nextTotal = Math.max(0, total - count);
        onQueueUpdate?.(nextTotal);
        return nextTotal;
      });
      batchSelection.clearSelection();
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể lưu quyết định duyệt hàng loạt.', 'warn');
      if ((requestError as { status?: number })?.status === 409) void loadQueue();
    } finally {
      setIsSubmitting(false);
    }
  };

  const requestBatchDecision = (next: PendingBatchDecision) => {
    if (batchSelection.selectedItems.length === 0 || isSubmitting) return;
    setPendingBatchDecision(next);
  };

  const confirmBatchDecision = () => {
    if (!pendingBatchDecision) return;
    const { decision, patch, corrections, referenceQueueId, productLinks, patchFields } = pendingBatchDecision;
    void resolveBatchItems(decision, patch, corrections, referenceQueueId, productLinks, patchFields)
      .finally(() => setPendingBatchDecision(null));
  };

  const handleReopen = async (item: ReviewQueueItem) => {
    if (reopeningId) return;
    setReopeningId(item.id);
    try {
      await apiRequest(`/api/review-queue/${item.id}/reopen`, { method: 'POST' });
      setSkippedItems((prev) => prev.filter((entry) => entry.id !== item.id));
      setSkippedTotal((count) => Math.max(0, count - 1));
      showToast('Đã đưa ảnh trở lại hàng chờ duyệt', 'success');
      setActiveTab('pending');
      await loadQueue();
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể mở lại ảnh này.', 'warn');
    } finally {
      setReopeningId(null);
    }
  };

  let pendingContent: React.ReactNode;
  if (loading || isWaitingForNextBatch) {
    pendingContent = <div className="h-full grid place-items-center text-[13px] text-text-3">Đang tải hàng chờ duyệt…</div>;
  } else if (error) {
    const isAuthError = error.toLowerCase().includes('đăng nhập') || error.toLowerCase().includes('auth');
    pendingContent = (
      <div className="h-full grid place-items-center p-8">
        <div className="max-w-md rounded-2xl border border-warn-border bg-warn-soft/80 backdrop-blur-md p-6 text-center text-warn shadow-sm space-y-4">
          <p className="text-[13.5px] font-medium leading-relaxed">{error}</p>
          <div className="flex items-center justify-center gap-3">
            {isAuthError && (
              <Link
                href="/login?returnUrl=/review"
                className="px-4 py-2 rounded-xl bg-verity hover:bg-verity-hover text-white text-[13px] font-bold shadow-sm transition-all"
              >
                Đăng nhập ngay
              </Link>
            )}
            <button
              type="button"
              onClick={() => void loadQueue()}
              className="px-4 py-2 rounded-xl border border-warn-border hover:bg-warn-soft text-[13px] font-semibold transition-all"
            >
              Thử lại
            </button>
          </div>
        </div>
      </div>
    );
  } else if (isQueueFinished) {
    pendingContent = (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center animate-pop">
        <div className="w-16 h-16 rounded-full bg-ok-soft text-ok grid place-items-center mb-4 shadow-sm">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-[20px] font-bold text-text-1 tracking-tight mb-2">Hết hàng chờ. Tốt lắm!</h2>
        <p className="text-[13.5px] text-text-2 max-w-[440px] leading-relaxed mb-6">
          Các ảnh được duyệt đã xuất hiện trong Thư viện. Bạn có thể quay lại upload lô mới hoặc xem danh sách cần ảnh.
        </p>
        {skippedTotal > 0 && (
          <button
            type="button"
            onClick={() => setActiveTab('skipped')}
            className="flex items-center gap-2 h-[42px] px-5 rounded-xl border border-border-strong bg-surface hover:bg-surface-2 text-text-1 text-[13.5px] font-bold transition-all shadow-xs mb-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
          >
            Xem {skippedTotal} ảnh đã để sau
          </button>
        )}
        <Link
          href="/shot"
          className="flex items-center gap-2 h-[42px] px-5 rounded-xl bg-verity hover:bg-verity-hover active:bg-verity-press text-white text-[13.5px] font-bold transition-all shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-offset-2"
        >
          <Target className="w-4 h-4" />
          <span>Xem danh sách Cần ảnh</span>
        </Link>
      </div>
    );
  } else if (viewMode === 'grid') {
    pendingContent = (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ReviewGrid
          items={queue}
          currentItemId={currentItem?.id}
          selectedIds={batchSelection.selectedIds}
          selectionMode={batchSelection.selectionMode}
          referenceId={batchSelection.referenceId}
          batchGroups={batchGroups}
          loadingMore={loadingMore}
          restoreFocusToId={returnFocusId}
          onOpen={openFocusView}
          onToggle={(item) => batchSelection.toggleId(item.id)}
          onRangeSelect={(item) => batchSelection.selectRange(item.id)}
          onSetSelection={(ids, referenceId) => batchSelection.selectBatchGroup(ids, referenceId)}
          onSetReference={(item) => batchSelection.setReferenceId(item.id)}
          onReachEnd={() => void loadNextQueuePage()}
        />
        <ReviewBatchBar
          selectionMode={batchSelection.selectionMode}
          selectedCount={batchSelection.selectedItems.length}
          loadedCount={queue.length}
          isSubmitting={isSubmitting}
          onClear={batchSelection.clearSelection}
          onSelectAll={() => batchSelection.selectAll()}
          onSkip={() => requestBatchDecision({ decision: 'skipped' })}
          onReject={() => requestBatchDecision({ decision: 'rejected' })}
          onReview={() => {
            setReviewPanel('metadata');
            setViewMode('focus');
          }}
        />
      </div>
    );
  } else {
    const imagePreview = (
      <ImagePreviewArea
        asset={currentItem.asset}
        queueItems={queue}
        currentIndex={currentIndex}
        onSelectIndex={setCurrentIndex}
        batchGroups={batchGroups}
        selectedIds={batchSelection.selectedIds}
        referenceId={batchSelection.referenceId}
        selectionMode={batchSelection.selectionMode}
        onBatchSelect={(ids) => {
          if (ids.length > 0) {
            batchSelection.selectBatchGroup(ids);
            const firstIndex = queue.findIndex((item) => item.id === ids[0]);
            if (firstIndex >= 0) setCurrentIndex(firstIndex);
          } else {
            batchSelection.clearSelection();
          }
        }}
        onToggleSelect={(id) => {
          batchSelection.toggleId(id);
        }}
        onRangeSelect={(id) => {
          batchSelection.selectRange(id);
        }}
        onSetReference={(id) => {
          batchSelection.setReferenceId(id);
        }}
        className={isCompactReview ? 'h-full min-h-0 p-0' : undefined}
      />
    );
    const metadataPanel = batchSelection.selectionMode === 'multi' ? (
      <BatchReviewForm
        selectedItems={batchSelection.selectedItems}
        referenceId={batchSelection.referenceId}
        suggestedSku={activeBatchGroup?.suggestedSku}
        suggestedSkuConfidence={activeBatchGroup?.suggestedSkuConfidence}
        suggestedBrand={activeBatchGroup?.suggestedBrand}
        suggestedCategory={activeBatchGroup?.suggestedCategory}
        suggestedSpace={activeBatchGroup?.suggestedSpace}
        onSetReference={batchSelection.setReferenceId}
        onApprove={(patch, corrections, refQueueId, productLinks, patchFields) =>
          requestBatchDecision({ decision: 'approved', patch, corrections, referenceQueueId: refQueueId, productLinks, patchFields })
        }
        onReject={() => requestBatchDecision({ decision: 'rejected' })}
        onSkip={() => requestBatchDecision({ decision: 'skipped' })}
        onClearSelection={batchSelection.clearSelection}
        isSubmitting={isSubmitting}
        className={isCompactReview ? 'h-full max-w-none w-full rounded-xl border' : undefined}
        style={!isCompactReview ? { width: inspector.width, maxWidth: inspector.width } : undefined}
      />
    ) : (
      <MetadataForm
        asset={currentItem.asset}
        isDuplicate={currentItem.is_duplicate}
        duplicateSimilarity={currentItem.duplicate_similarity}
        duplicateMatches={currentItem.duplicate_matches}
        skuMatch={currentItem.sku_match}
        metadataDraft={currentItem.metadata_draft}
        dedupSummary={currentItem.dedup_summary}
        onReplaceDuplicate={(replaceIds) =>
          void resolveCurrentItem('approved', currentItem.asset, [], replaceIds)
        }
        onKeepDuplicate={() => showToast('Giữ cả 2 ảnh trong kho', 'info')}
        onDropDuplicate={() => void resolveCurrentItem('rejected')}
        onApprove={(asset, corrections, productLinks) =>
          void resolveCurrentItem('approved', asset, corrections, undefined, productLinks)
        }
        onReject={() => void resolveCurrentItem('rejected')}
        onSkip={handleSkip}
        isSubmitting={isSubmitting}
        className={isCompactReview ? 'h-full max-w-none w-full rounded-xl border' : undefined}
        style={!isCompactReview ? { width: inspector.width, maxWidth: inspector.width } : undefined}
      />
    );

    pendingContent = (
      <>
        {isDemoMode ? (
          <div className="mx-3 mt-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-800 sm:mx-6 sm:mt-4 sm:px-4 sm:text-[13px]">
            Chế độ demo local — quyết định duyệt chỉ được lưu trong bộ nhớ của dev server này.
          </div>
        ) : null}
        {isCompactReview ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden bg-paper p-2 sm:gap-3 sm:p-4">
            <AccessibleTabs
              tabs={[
                { value: 'image', label: 'Ảnh', icon: <ImageIcon className="h-4 w-4" aria-hidden="true" /> },
                { value: 'metadata', label: 'Metadata', icon: <ListChecks className="h-4 w-4" aria-hidden="true" /> },
              ]}
              value={reviewPanel}
              onValueChange={(value) => setReviewPanel(value as 'image' | 'metadata')}
              ariaLabel="Nội dung duyệt ảnh"
              className="flex min-h-0 flex-1 flex-col"
              listClassName="flex-none"
            >
              <AccessibleTabPanel value="image" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                {imagePreview}
              </AccessibleTabPanel>
              <AccessibleTabPanel value="metadata" className="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden">
                {metadataPanel}
              </AccessibleTabPanel>
            </AccessibleTabs>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {imagePreview}
            <ReviewColumnResizer
              width={inspector.width}
              minWidth={inspector.minWidth}
              maxWidth={inspector.maxWidth}
              onChange={inspector.setWidth}
              onReset={inspector.resetWidth}
            />
            {metadataPanel}
          </div>
        )}
      </>
    );
  }

  const skippedContent = skippedLoading ? (
    <div className="h-full grid place-items-center text-[13px] text-text-3">Đang tải…</div>
  ) : skippedError ? (
    <div className="h-full grid place-items-center p-8">
      <div className="max-w-md rounded-2xl border border-warn-border bg-warn-soft/80 backdrop-blur-md p-6 text-center text-warn shadow-sm space-y-4">
        <p className="text-[13.5px] font-medium leading-relaxed">{skippedError}</p>
        <button
          type="button"
          onClick={() => void loadSkipped()}
          className="px-4 py-2 rounded-xl border border-warn-border hover:bg-warn-soft text-[13px] font-semibold transition-all"
        >
          Thử lại
        </button>
      </div>
    </div>
  ) : skippedItems.length === 0 ? (
    <div className="h-full grid place-items-center p-8 text-center">
      <p className="text-[13.5px] text-text-3 max-w-[360px] leading-relaxed">
        Chưa có ảnh nào được để sau. Bấm &quot;Để sau&quot; trong màn hình duyệt để tạm gác một ảnh — ảnh vẫn giữ nguyên trong hàng chờ, không mất đi đâu cả.
      </p>
    </div>
  ) : (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {skippedItems.map((item) => (
          <div key={item.id} className="rounded-xl border border-border bg-surface overflow-hidden shadow-xs flex flex-col">
            <div className="h-[120px] bg-surface-2 flex-none">
              {item.asset?.thumbnail_url && (
                <img src={item.asset.thumbnail_url} alt={item.asset.title || item.asset.sku} className="w-full h-full object-cover" />
              )}
            </div>
            <div className="p-3 space-y-1 flex-1 flex flex-col">
              <p className="text-[12.5px] font-bold text-text-1 truncate">{item.asset?.title || item.asset?.sku || 'Chưa đặt tên'}</p>
              <p className="text-[11px] text-text-3 truncate">{[item.asset?.brand, item.asset?.category].filter(Boolean).join(' · ') || '—'}</p>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => void handleReopen(item)}
                disabled={reopeningId === item.id}
                className="h-[30px] mt-1.5 rounded-lg bg-verity hover:bg-verity-hover disabled:opacity-60 text-white text-[11.5px] font-bold transition-all"
              >
                Xem lại ngay
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    // `<main>` (AppShell) is a plain block box, not a flex container -- `flex-1`
    // here is a no-op against it, so this root silently loses its viewport-
    // bounded height (falls back to auto/shrink-to-fit). That breaks every
    // flex-1/min-h-0 height cascade below it (image panel, MetadataForm's
    // scroll body + sticky footer), which is why the approve/reject/skip
    // footer can render off-screen with nothing left to scroll it into view.
    // `h-full` is the one that actually works here, because `<main>` still
    // gets a definite height from ITS OWN flex parent in AppShell -- CSS
    // percentage heights resolve against that just fine even though `<main>`
    // itself isn't `display:flex`. See e2e/responsive/shell.spec.ts's
    // main-content scrollHeight/approve-button-visible assertions.
    <div data-testid="review-layout" className="flex h-full min-h-0 flex-col overflow-hidden bg-paper">
      <TopbarPortal>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-1.5 sm:gap-2 overflow-hidden">
          <div className="flex min-w-0 shrink items-center gap-1 overflow-x-auto no-scrollbar">
            <button
              type="button"
              onClick={() => setActiveTab('pending')}
              className={clsx(
                'h-[28px] shrink-0 whitespace-nowrap rounded-md px-2 text-[11.5px] font-semibold transition-all sm:h-[30px] sm:px-2.5 sm:text-[12px]',
                activeTab === 'pending' ? 'bg-verity text-white shadow-xs' : 'text-text-2 hover:bg-hover'
              )}
            >
              Cần duyệt{!loading && pendingTotal > 0 ? ` (${pendingTotal})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('skipped')}
              className={clsx(
                'h-[28px] shrink-0 whitespace-nowrap rounded-md px-2 text-[11.5px] font-semibold transition-all sm:h-[30px] sm:px-2.5 sm:text-[12px]',
                activeTab === 'skipped' ? 'bg-verity text-white shadow-xs' : 'text-text-2 hover:bg-hover'
              )}
            >
              Để sau{skippedTotal > 0 ? ` (${skippedTotal})` : ''}
            </button>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 flex-none ml-auto">
            {activeTab === 'pending' && loadingMore ? (
              <span className="hidden lg:inline shrink-0 text-[11px] text-text-3" aria-live="polite">
                Đang tải thêm…
              </span>
            ) : null}
            {activeTab === 'pending' && !loading && !error && !isQueueFinished ? (
              <ReviewToolbar
                viewMode={viewMode}
                currentIndex={currentIndex}
                totalCount={pendingTotal}
                onViewModeChange={(mode) => {
                  if (mode === 'grid') setReturnFocusId(currentItem?.id ?? null);
                  setViewMode(mode);
                }}
              />
            ) : null}
          </div>
        </div>
      </TopbarPortal>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {activeTab === 'pending' ? pendingContent : skippedContent}
      </div>
      {activeTab === 'pending' && batchSelection.selectionMode === 'multi' ? (
        <QuickBatchActionBar
          selectedItems={batchSelection.selectedItems}
          referenceId={batchSelection.referenceId}
          suggestedSku={activeBatchGroup?.suggestedSku}
          suggestedSkuConfidence={activeBatchGroup?.suggestedSkuConfidence}
          suggestedBrand={activeBatchGroup?.suggestedBrand}
          onSetReference={batchSelection.setReferenceId}
          onApprove={(patch, corrections, refQueueId, productLinks, patchFields) =>
            requestBatchDecision({ decision: 'approved', patch, corrections, referenceQueueId: refQueueId, productLinks, patchFields })
          }
          onReject={() => requestBatchDecision({ decision: 'rejected' })}
          onSkip={() => requestBatchDecision({ decision: 'skipped' })}
          onClearSelection={batchSelection.clearSelection}
          isSubmitting={isSubmitting}
        />
      ) : null}
      {pendingBatchDecision ? (
        <ReviewDecisionConfirm
          open
          decision={pendingBatchDecision.decision}
          items={batchSelection.selectedItems}
          submitting={isSubmitting}
          onOpenChange={(open) => { if (!open && !isSubmitting) setPendingBatchDecision(null); }}
          onConfirm={confirmBatchDecision}
        />
      ) : null}
    </div>
  );
}
