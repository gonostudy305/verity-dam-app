'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MediaAsset, FilterState, SearchMeta } from '@/types/media';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { isUuid, isMediaUrlOrPathCandidate } from '@/lib/media-api';
import { SearchInput } from './SearchInput';
import { HorizontalFilterBar } from './HorizontalFilterBar';
import { MasonryGrid } from './MasonryGrid';
import { JustifiedGrid } from './JustifiedGrid';
import { ViewMode } from './ViewModeSwitcher';
import { DetailDrawer } from './DetailDrawer';
import { BatchBar } from './BatchBar';
import { ReportIssueModal } from './ReportIssueModal';
import { useToast } from '@/components/common/Toast';
import { cn } from '@/lib/utils';
import { useTaxonomy } from '@/hooks/useTaxonomy';

interface LibraryResponse {
  data: MediaAsset[];
  total: number;
  mode?: 'demo';
  search_meta?: SearchMeta;
}

const EMPTY_FILTERS: FilterState = {
  category: [],
  space: [],
  status: [],
  permission: [],
  source: [],
  media_type: [],
  only_ai: false,
  only_people: false,
  only_internal: false,
  only_needs_post_production: false,
};

const PAGE_SIZE = 40;
type ArchiveClientStatus = {
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'cancelled' | 'expired';
  processed_assets: number;
  total_assets: number;
  error_message?: string | null;
  download_url?: string | null;
};

export function LibraryView() {
  const { showToast } = useToast();
  const { taxonomy } = useTaxonomy();
  const [items, setItems] = useState<MediaAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Real, backend-reported facts about what the search engine did with the
  // current query (Batch 2: search truthfulness) -- never a client-side
  // guess. This remains available for the truthful mode badge and telemetry.
  const [searchMeta, setSearchMeta] = useState<SearchMeta | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeDrawerAsset, setActiveDrawerAsset] = useState<MediaAsset | null>(null);
  const [showReportModal, setShowReportModal] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();

  // Deep-link: ?asset=<uuid>, ?url=<url>, or ?path=<path> opens DetailDrawer
  useEffect(() => {
    const assetId = searchParams?.get('asset');
    const targetUrl = searchParams?.get('url') || searchParams?.get('path');

    if (assetId && isUuid(assetId)) {
      let active = true;
      apiRequest<{ data: MediaAsset }>(`/api/media/${assetId}`)
        .then((res) => {
          if (!active || !res.data) return;
          setActiveDrawerAsset(res.data);
          router.replace('/library');
        })
        .catch((err) => {
          console.error('Failed to open deep-linked asset:', err);
        });

      return () => {
        active = false;
      };
    }

    if (targetUrl) {
      let active = true;
      apiRequest<{ success: boolean; data: MediaAsset }>(`/api/media/resolve?url=${encodeURIComponent(targetUrl)}`)
        .then((res) => {
          if (!active || !res.data) return;
          setActiveDrawerAsset(res.data);
          showToast('Đã mở thông tin ảnh theo đường dẫn', 'success');
          router.replace('/library');
        })
        .catch((err) => {
          console.error('Failed to resolve deep-linked image URL:', err);
          showToast('Không tìm thấy ảnh từ liên kết đã cung cấp.', 'warn');
        });

      return () => {
        active = false;
      };
    }
  }, [searchParams, router, showToast]);
  const [sortOption, setSortOption] = useState<'newest' | 'most_used' | 'unused'>('newest');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [viewMode, setViewMode] = useState<ViewMode>('justified');

  useEffect(() => {
    try {
      const storedMode = window.localStorage.getItem('verity_media_view_mode') as ViewMode | null;
      if (storedMode === 'justified' || storedMode === 'masonry') setViewMode(storedMode);
    } catch {}
  }, []);

  const handleViewModeChange = (nextMode: ViewMode) => {
    setViewMode(nextMode);
    try {
      window.localStorage.setItem('verity_media_view_mode', nextMode);
    } catch {}
  };
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);
  const [tagAddInput, setTagAddInput] = useState('');
  const [tagRemoveInput, setTagRemoveInput] = useState('');
  const [isSavingTags, setIsSavingTags] = useState(false);
  const [archiveJobId, setArchiveJobId] = useState<string | null>(null);
  const [archiveStatus, setArchiveStatus] = useState<ArchiveClientStatus | null>(null);

  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    const active = {
      category: new Set(taxonomy.category.filter((item) => item.isActive !== false).map((item) => item.value)),
      space: new Set(taxonomy.space.filter((item) => item.isActive !== false).map((item) => item.value)),
      status: new Set(taxonomy.status.filter((item) => item.isActive !== false).map((item) => item.value)),
      source: new Set(taxonomy.brand.filter((item) => item.isActive !== false).map((item) => item.value)),
      permission: new Set(taxonomy.permission.filter((item) => item.isActive !== false).map((item) => item.value)),
    };
    setFilters((current) => {
      const next = {
        ...current,
        category: current.category.filter((value) => active.category.has(value)),
        space: current.space.filter((value) => active.space.has(value)),
        status: current.status.filter((value) => active.status.has(value)),
        source: current.source.filter((value) => active.source.has(value)),
        permission: current.permission.filter((value) => active.permission.has(value)),
      };
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [taxonomy]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({
        q: searchQuery,
        sort: sortOption,
        page: '1',
        page_size: String(PAGE_SIZE),
      });
      const appendList = (name: string, values: string[]) => values.forEach((value) => params.append(name, value));
      appendList('category', filters.category);
      appendList('space', filters.space);
      appendList('status', filters.status);
      appendList('permission', filters.permission);
      appendList('source', filters.source);
      appendList('media_type', filters.media_type);
      if (filters.only_ai) params.set('only_ai', 'true');
      if (filters.only_people) params.set('only_people', 'true');
      if (filters.only_internal) params.set('only_internal', 'true');
      if (filters.only_needs_post_production) params.set('only_needs_post_production', 'true');

      try {
        const response = await apiRequest<LibraryResponse>(`/api/media?${params}`, { signal: controller.signal });
        setItems(response.data);
        setTotal(response.total);
        setPage(1);
        setIsDemoMode(response.mode === 'demo');
        setSearchMeta(response.search_meta ?? null);
        setSelectedIds((current) => current.filter((id) => response.data.some((asset) => asset.id === id)));

        // If query was an image URL/path candidate and exactly 1 result was resolved, auto-open drawer
        if (isMediaUrlOrPathCandidate(searchQuery) && response.data.length === 1) {
          setActiveDrawerAsset(response.data[0]);
          showToast('Đã tìm thấy và mở chi tiết ảnh!', 'success');
        }
      } catch (requestError) {
        if (controller.signal.aborted) return;
        setItems([]);
        setTotal(0);
        setPage(1);
        setIsDemoMode(false);
        setSearchMeta(null);
        setError(requestError instanceof Error ? requestError.message : 'Không thể tải thư viện.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filterKey, filters, reloadKey, searchQuery, sortOption]);

  const hasMore = items.length < total;

  const handleLoadMore = useCallback(async () => {
    if (loading || isLoadingMore || !hasMore) return;
    const nextPage = page + 1;
    setIsLoadingMore(true);

    const params = new URLSearchParams({
      q: searchQuery,
      sort: sortOption,
      page: String(nextPage),
      page_size: String(PAGE_SIZE),
    });
    const appendList = (name: string, values: string[]) => values.forEach((value) => params.append(name, value));
    appendList('category', filters.category);
    appendList('space', filters.space);
    appendList('status', filters.status);
    appendList('permission', filters.permission);
    appendList('source', filters.source);
    appendList('media_type', filters.media_type);
    if (filters.only_ai) params.set('only_ai', 'true');
    if (filters.only_people) params.set('only_people', 'true');
    if (filters.only_internal) params.set('only_internal', 'true');
    if (filters.only_needs_post_production) params.set('only_needs_post_production', 'true');

    try {
      const response = await apiRequest<LibraryResponse>(`/api/media?${params}`);
      setItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id));
        const newBatch = response.data.filter((item) => !existingIds.has(item.id));
        return [...prev, ...newBatch];
      });
      setTotal(response.total);
      setPage(nextPage);
    } catch {
      // Retain items on error so user can continue viewing
    } finally {
      setIsLoadingMore(false);
    }
  }, [loading, isLoadingMore, hasMore, page, searchQuery, sortOption, filters]);

  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
  };

  const handleSearchSubmit = useCallback(async () => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    if (isMediaUrlOrPathCandidate(trimmed)) {
      setLoading(true);
      try {
        const res = await apiRequest<{ success: boolean; data: MediaAsset }>(
          `/api/media/resolve?url=${encodeURIComponent(trimmed)}`
        );
        if (res.data) {
          setItems([res.data]);
          setTotal(1);
          setActiveDrawerAsset(res.data);
          showToast('Đã tìm thấy và mở chi tiết ảnh!', 'success');
        }
      } catch {
        showToast('Không tìm thấy ảnh từ liên kết hoặc đường dẫn này.', 'warn');
      } finally {
        setLoading(false);
      }
    }
  }, [searchQuery, showToast]);

  const handleToggleSelect = useCallback((id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setSelectedIds((current) => current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id]);
  }, []);

  // Batch 9: one server-prepared archive replaces the old one-browser-download
  // per asset loop. The job is durable and the polling effect below resumes it
  // after a request/worker interruption.
  const handleBatchDownload = async () => {
    if (selectedIds.length === 0 || isBatchDownloading) return;
    setIsBatchDownloading(true);
    try {
      const response = await apiRequest<{ data: { id: string; status: ArchiveClientStatus['status']; total_assets: number; processed_assets: number } }>(
        '/api/media/batch/archive',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds }),
        }
      );
      setArchiveJobId(response.data.id);
      setArchiveStatus({
        status: response.data.status,
        total_assets: response.data.total_assets,
        processed_assets: response.data.processed_assets,
      });
    } catch (requestError) {
      setIsBatchDownloading(false);
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        showToast('Bạn cần quyền Contributor trở lên để tải archive.', 'warn');
      } else {
        showToast(requestError instanceof Error ? requestError.message : 'Không thể tạo archive.', 'warn');
      }
    }
  };

  useEffect(() => {
    if (!archiveJobId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await apiRequest<{ data: ArchiveClientStatus }>(`/api/media/batch/archive/${archiveJobId}`);
        if (!active) return;
        setArchiveStatus(response.data);
        if (response.data.status === 'ready' && response.data.download_url) {
          const link = document.createElement('a');
          link.href = response.data.download_url;
          link.download = 'verity-media.zip';
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
          setIsBatchDownloading(false);
          showToast('Archive đã sẵn sàng và bắt đầu tải xuống.', 'success');
          return;
        }
        if (['failed', 'cancelled', 'expired'].includes(response.data.status)) {
          setIsBatchDownloading(false);
          return;
        }
        timer = window.setTimeout(() => void poll(), 1000);
      } catch (requestError) {
        if (!active) return;
        setIsBatchDownloading(false);
        showToast(requestError instanceof Error ? requestError.message : 'Không thể kiểm tra archive.', 'warn');
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [archiveJobId, showToast]);

  const handleCancelArchive = async () => {
    if (!archiveJobId) return;
    try {
      await apiRequest(`/api/media/batch/archive/${archiveJobId}/cancel`, { method: 'POST' });
      setArchiveStatus((current) => current ? { ...current, status: 'cancelled' } : current);
      setIsBatchDownloading(false);
      showToast('Đã huỷ chuẩn bị archive.', 'info');
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể huỷ archive.', 'warn');
    }
  };

  const handleRetryArchive = async () => {
    if (!archiveJobId) return;
    setIsBatchDownloading(true);
    try {
      await apiRequest(`/api/media/batch/archive/${archiveJobId}/retry`, { method: 'POST' });
      setArchiveStatus((current) => current ? { ...current, status: 'queued', processed_assets: 0 } : current);
    } catch (requestError) {
      setIsBatchDownloading(false);
      showToast(requestError instanceof Error ? requestError.message : 'Không thể thử lại archive.', 'warn');
    }
  };

  // Batch 7: BatchBar's "Sửa tag" used to just show a fake "will apply to N
  // photos" info toast with no form and no request ever sent. Now opens a
  // real add/remove-tags form calling PATCH /api/media/batch/keywords, and
  // merges the server's per-asset result back into local state so the
  // Library grid reflects the change without a full refetch.
  const handleSaveBatchTags = async () => {
    const add = tagAddInput.split(',').map((t) => t.trim()).filter(Boolean);
    const remove = tagRemoveInput.split(',').map((t) => t.trim()).filter(Boolean);
    if ((add.length === 0 && remove.length === 0) || isSavingTags) return;
    setIsSavingTags(true);
    try {
      const response = await apiRequest<{ data: { updated: number; keywords_by_id: Record<string, string[]> } }>(
        '/api/media/batch/keywords',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds, add, remove }),
        }
      );
      setItems((current) =>
        current.map((item) =>
          response.data.keywords_by_id[item.id] ? { ...item, keywords: response.data.keywords_by_id[item.id] } : item
        )
      );
      showToast(`Đã cập nhật tag cho ${response.data.updated} ảnh`, 'success');
      setShowTagModal(false);
      setTagAddInput('');
      setTagRemoveInput('');
    } catch (requestError) {
      if (requestError instanceof ClientApiError && requestError.status === 403) {
        showToast('Bạn cần quyền Contributor trở lên để sửa tag hàng loạt.', 'warn');
      } else {
        showToast(requestError instanceof Error ? requestError.message : 'Không thể cập nhật tag.', 'warn');
      }
    } finally {
      setIsSavingTags(false);
    }
  };

  const handleOpenDetail = useCallback(async (asset: MediaAsset) => {
    setActiveDrawerAsset(asset);
    try {
      const response = await apiRequest<{ data: MediaAsset }>(`/api/media/${asset.id}`);
      const refreshed = response?.data;
      if (refreshed && typeof refreshed === 'object' && !Array.isArray(refreshed) && refreshed.id === asset.id) {
        setActiveDrawerAsset((current) => current?.id === asset.id ? refreshed : current);
      }
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể tải chi tiết ảnh.', 'warn');
    }
  }, [showToast]);

  const clearAllFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchQuery('');
    showToast('Đã xóa toàn bộ bộ lọc', 'info');
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-paper overflow-hidden" suppressHydrationWarning>
      {/* Top Search Input */}
      <SearchInput
        value={searchQuery}
        onChange={handleSearchChange}
        onSubmit={handleSearchSubmit}
        searchMode={
          searchMeta?.recovery_stage === 'URL_EXACT_RESOLVED'
            ? 'khớp liên kết / URL'
            : searchMeta?.used
            ? searchMeta.semantic_active
              ? 'tìm kiếm AI + ngữ nghĩa'
              : 'tìm kiếm thông minh'
            : 'tìm kiếm cơ bản'
        }
      />

      {/* Horizontal Top Filter Bar */}
      <HorizontalFilterBar
        filters={filters}
        onChange={setFilters}
        onClear={clearAllFilters}
        totalResults={total}
        sortOption={sortOption}
        onSortChange={setSortOption}
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
      />

      {error ? (
        <div className="mx-6 mb-3 flex items-center justify-between gap-4 rounded-xl border border-warn-border bg-warn-soft px-4 py-3 text-[13px] text-warn">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="font-bold underline">Thử lại</button>
        </div>
      ) : null}

      {isDemoMode ? (
        <div className="mx-6 mb-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-[13px] text-sky-800">
          Chế độ demo local — dữ liệu chưa được lưu vào PostgreSQL/R2. Tắt <code>VERITY_MEDIA_DEMO_MODE</code> sau khi hoàn tất Auth và role.
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto min-h-0 pt-2 isolate">
        {viewMode === 'justified' ? (
          <JustifiedGrid
            items={items}
            loading={loading}
            searchQuery={searchQuery}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onOpenDetail={handleOpenDetail}
            onApplySuggestion={handleSearchChange}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
          />
        ) : (
          <MasonryGrid
            items={items}
            loading={loading}
            searchQuery={searchQuery}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onOpenDetail={handleOpenDetail}
            onApplySuggestion={handleSearchChange}
            onLoadMore={handleLoadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
          />
        )}
      </div>

      <DetailDrawer
        asset={activeDrawerAsset}
        onClose={() => setActiveDrawerAsset(null)}
        onAssetDeleted={(assetId) => {
          setItems((current) => current.filter((item) => item.id !== assetId));
          setTotal((current) => Math.max(0, current - 1));
          setSelectedIds((current) => current.filter((id) => id !== assetId));
          setActiveDrawerAsset(null);
        }}
        onAssetUpdated={(updatedAsset) => {
          setActiveDrawerAsset(updatedAsset);
          setItems((current) =>
            current.map((item) => (item.id === updatedAsset.id ? updatedAsset : item))
          );
        }}
      />
      <BatchBar
        selectedCount={selectedIds.length}
        onDownload={() => void handleBatchDownload()}
        isDownloading={isBatchDownloading}
        archiveStatus={archiveStatus ? {
          status: archiveStatus.status,
          processedAssets: archiveStatus.processed_assets,
          totalAssets: archiveStatus.total_assets,
          errorMessage: archiveStatus.error_message,
        } : null}
        onCancelDownload={() => void handleCancelArchive()}
        onRetryDownload={() => void handleRetryArchive()}
        onEditTags={() => setShowTagModal(true)}
        onReport={() => setShowReportModal(true)}
        onClearSelection={() => setSelectedIds([])}
      />

      {showTagModal && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => setShowTagModal(false)}
        >
          <div
            className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 shadow-lg space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="text-[14.5px] font-bold text-text-1">Sửa tag hàng loạt</h3>
            <p className="text-[12.5px] text-text-2 leading-relaxed">
              Áp dụng cho {selectedIds.length} ảnh đã chọn. Cách nhau bởi dấu phẩy.
            </p>
            <div>
              <p className="text-[12px] text-text-3 mb-1">Thêm tag</p>
              <input
                type="text"
                value={tagAddInput}
                onChange={(event) => setTagAddInput(event.target.value)}
                placeholder="ví dụ: sofa, phòng khách"
                className="w-full h-[38px] px-3 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-verity"
              />
            </div>
            <div>
              <p className="text-[12px] text-text-3 mb-1">Bỏ tag</p>
              <input
                type="text"
                value={tagRemoveInput}
                onChange={(event) => setTagRemoveInput(event.target.value)}
                placeholder="ví dụ: draft"
                className="w-full h-[38px] px-3 rounded-lg border border-border bg-surface-inset text-[13px] outline-none focus:border-verity"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowTagModal(false)}
                className="h-[36px] px-3.5 rounded-lg border border-border text-text-2 hover:bg-hover text-[12.5px] font-semibold transition-all"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void handleSaveBatchTags()}
                disabled={(!tagAddInput.trim() && !tagRemoveInput.trim()) || isSavingTags}
                className="h-[36px] px-3.5 rounded-lg bg-verity hover:bg-verity-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-bold transition-all"
              >
                {isSavingTags ? 'Đang lưu…' : 'Áp dụng'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReportModal && (
        <ReportIssueModal
          assetIds={selectedIds}
          isOpen={showReportModal}
          onClose={() => setShowReportModal(false)}
          onReported={(count) => {
            setShowReportModal(false);
            showToast(`Đã ghi nhận báo lỗi (${count} ảnh)`, 'success');
          }}
        />
      )}
    </div>
  );
}
