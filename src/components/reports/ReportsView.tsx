'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Flag,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type {
  GroupedAssetReportCard,
  AssetReportReason,
  AssetReportStatus,
} from '@/lib/server/asset-reports';
import { ReportCard } from './ReportCard';
import { ReportFixModal } from './ReportFixModal';

interface ListReportsResponse {
  success: boolean;
  data: GroupedAssetReportCard[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_TABS: { value: AssetReportStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Đang mở' },
  { value: 'in_review', label: 'Đang xử lý' },
  { value: 'resolved', label: 'Đã xử lý' },
  { value: 'dismissed', label: 'Đã bỏ qua' },
  { value: 'all', label: 'Tất cả' },
];

const REASON_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Tất cả lý do' },
  { value: 'wrong_sku', label: 'Sai SKU' },
  { value: 'wrong_recognition', label: 'Nhận diện / mô tả sai' },
  { value: 'wrong_url', label: 'Link ảnh lỗi' },
  { value: 'other', label: 'Khác' },
];

export function ReportsView() {
  const [selectedStatus, setSelectedStatus] = useState<AssetReportStatus | 'all'>('open');
  const [selectedReason, setSelectedReason] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [pageSize] = useState<number>(20);

  const [cards, setCards] = useState<GroupedAssetReportCard[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [activeFixCard, setActiveFixCard] = useState<GroupedAssetReportCard | null>(null);

  const fetchReports = useCallback(
    async (showLoadingSpinner = true) => {
      if (showLoadingSpinner) setIsLoading(true);
      else setIsRefreshing(true);
      setError(null);

      try {
        const queryParams = new URLSearchParams();
        queryParams.set('status', selectedStatus);
        if (selectedReason) queryParams.set('reason', selectedReason);
        queryParams.set('page', String(page));
        queryParams.set('page_size', String(pageSize));

        const res = await apiRequest<ListReportsResponse>(
          `/api/asset-reports?${queryParams.toString()}`
        );

        setCards(res.data || []);
        setTotal(res.total || 0);
      } catch (err) {
        if (err instanceof ClientApiError) {
          setError(err.message);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Không thể tải danh sách báo lỗi.');
        }
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [selectedStatus, selectedReason, page, pageSize]
  );

  useEffect(() => {
    fetchReports(true);
  }, [fetchReports]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col h-full overflow-hidden bg-paper">
      {/* Top Filter & Toolbar Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 shrink-0">
        {/* Status Tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
          {STATUS_TABS.map((tab) => {
            const isSelected = selectedStatus === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                onClick={() => {
                  setSelectedStatus(tab.value);
                  setPage(1);
                }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12.5px] font-semibold transition-all cursor-pointer whitespace-nowrap',
                  isSelected
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text-1 border border-transparent'
                )}
              >
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Reason Filter & Refresh */}
        <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
          <div className="relative">
            <select
              value={selectedReason}
              onChange={(e) => {
                setSelectedReason(e.target.value);
                setPage(1);
              }}
              className="h-8.5 rounded-xl border border-border bg-surface pl-2.5 pr-7 text-[12px] font-semibold text-text-1 outline-hidden focus:border-amber-500 cursor-pointer"
            >
              {REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => fetchReports(false)}
            disabled={isLoading || isRefreshing}
            className="grid h-8.5 w-8.5 place-items-center rounded-xl border border-border bg-surface text-text-2 hover:bg-surface-2 hover:text-text-1 transition-all cursor-pointer disabled:opacity-50"
            title="Làm mới danh sách"
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin text-amber-500')}
            />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="max-w-5xl mx-auto space-y-4">
          {error && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-red-200/80 bg-red-50/80 dark:bg-red-950/40 p-4 text-[13px] text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="flex-1">{error}</span>
            </div>
          )}

          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-20 text-text-3 space-y-2.5">
              <Loader2 className="h-6 w-6 animate-spin text-amber-500" />
              <p className="text-[13px] font-medium">Đang tải báo lỗi...</p>
            </div>
          ) : cards.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center rounded-3xl border border-dashed border-border bg-surface/50 p-8">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 mb-3 border border-emerald-500/20">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <h3 className="text-[15px] font-bold text-text-1">
                {selectedStatus === 'open'
                  ? 'Không có báo lỗi nào đang mở'
                  : 'Không có báo lỗi nào phù hợp'}
              </h3>
              <p className="text-[13px] text-text-3 max-w-sm mt-1">
                {selectedStatus === 'open'
                  ? 'Tất cả các ảnh đều chuẩn xác hoặc các báo lỗi trước đó đã được xử lý xong.'
                  : 'Hãy thử thay đổi trạng thái hoặc bộ lọc lý do báo lỗi.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="flex items-center justify-between text-[12.5px] text-text-3 px-1">
                <span>
                  Tìm thấy <strong className="text-text-1 font-semibold">{total}</strong> ảnh có báo lỗi
                </span>
                <span>
                  Trang {page} / {totalPages}
                </span>
              </div>

              {cards.map((card) => (
                <ReportCard
                  key={card.media_asset_id}
                  card={card}
                  onRefresh={() => fetchReports(false)}
                  onFix={(targetCard) => setActiveFixCard(targetCard)}
                />
              ))}

              {/* Pagination controls */}
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-4 pb-8">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-surface text-[12.5px] font-semibold text-text-1 hover:bg-surface-2 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    <span>Trước</span>
                  </button>
                  <span className="text-[12px] font-mono text-text-3 px-2">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-surface text-[12.5px] font-semibold text-text-1 hover:bg-surface-2 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <span>Sau</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Dedicated Report Resolution & Fix Modal */}
      {activeFixCard && (
        <ReportFixModal
          isOpen={Boolean(activeFixCard)}
          card={activeFixCard}
          onClose={() => setActiveFixCard(null)}
          onSuccess={() => {
            setActiveFixCard(null);
            fetchReports(false);
          }}
        />
      )}
    </div>
  );
}
