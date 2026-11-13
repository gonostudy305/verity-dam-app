'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  EyeOff,
  Loader2,
  RotateCcw,
  User,
  Wrench,
} from 'lucide-react';
import { apiRequest } from '@/lib/client/api';
import { formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { GroupedAssetReportCard, AssetReport } from '@/lib/server/asset-reports';
import { ReportReasonBadge, ReportStatusBadge } from './ReportReasonBadge';
import { ReportResolveDialog } from './ReportResolveDialog';

interface ReportCardProps {
  card: GroupedAssetReportCard;
  onRefresh: () => void;
  onFix?: (card: GroupedAssetReportCard) => void;
  onEditAsset?: (assetId: string) => void;
  isLoadingAsset?: boolean;
}

export function ReportCard({
  card,
  onRefresh,
  onFix,
  onEditAsset,
  isLoadingAsset = false,
}: ReportCardProps) {
  const [resolveDialogState, setResolveDialogState] = useState<{
    isOpen: boolean;
    targetStatus: 'resolved' | 'dismissed';
  }>({
    isOpen: false,
    targetStatus: 'resolved',
  });
  const [isProcessingAction, setIsProcessingAction] = useState(false);

  const openReports = card.reports.filter(
    (r) => r.status === 'open' || r.status === 'in_review'
  );
  const hasOpenReports = openReports.length > 0;
  const openReportIds = openReports.map((r) => r.id);
  const allReportIds = card.reports.map((r) => r.id);

  // Transition to in_review directly
  const handleSetInReview = async () => {
    if (isProcessingAction || !openReportIds.length) return;
    setIsProcessingAction(true);
    try {
      await apiRequest('/api/asset-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_ids: openReportIds,
          status: 'in_review',
        }),
      });
      onRefresh();
    } catch (err) {
      console.error('Failed to set in_review:', err);
    } finally {
      setIsProcessingAction(false);
    }
  };

  // Reopen to open directly
  const handleReopen = async () => {
    if (isProcessingAction || !allReportIds.length) return;
    setIsProcessingAction(true);
    try {
      await apiRequest('/api/asset-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_ids: allReportIds,
          status: 'open',
        }),
      });
      onRefresh();
    } catch (err) {
      console.error('Failed to reopen reports:', err);
    } finally {
      setIsProcessingAction(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-surface shadow-xs overflow-hidden transition-all hover:border-border-strong">
      {/* Top Banner: Asset Info + Primary Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 sm:p-5 border-b border-border bg-surface-2/40">
        <div className="flex items-center gap-3.5 min-w-0">
          {/* Thumbnail */}
          <div className="relative h-14 w-14 shrink-0 rounded-xl overflow-hidden border border-border bg-surface-3">
            {card.asset.thumbnail_url ? (
              <img
                src={card.asset.thumbnail_url}
                alt={card.asset.title}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full grid place-items-center text-text-3 font-mono text-[10px]">
                NO IMG
              </div>
            )}
            {card.asset.needs_post_production && (
              <span
                className="absolute top-1 left-1 grid h-4 w-4 place-items-center rounded bg-amber-500 text-white shadow-xs"
                title="Đang gắn cờ Cần hậu kỳ"
              >
                <Wrench className="h-2.5 w-2.5" />
              </span>
            )}
          </div>

          {/* Metadata */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[12.5px] font-bold text-text-1 px-2 py-0.5 rounded-md bg-surface border border-border">
                {card.asset.sku || 'CHƯA CÓ SKU'}
              </span>
              {hasOpenReports ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 dark:bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-bold text-amber-600 dark:text-amber-400 border border-amber-500/30">
                  <AlertTriangle className="h-3 w-3" />
                  {card.open_count} báo lỗi đang mở
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="h-3 w-3" />
                  Đã xử lý xong
                </span>
              )}
            </div>
            <h4 className="mt-1 text-[13.5px] font-semibold text-text-1 truncate max-w-[420px]" title={card.asset.title}>
              {card.asset.title || 'Không có tiêu đề'}
            </h4>
          </div>
        </div>

        {/* Action Dock */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end shrink-0 flex-wrap">
          {/* In-situ Edit Button or Deep-link */}
          {onFix ? (
            <button
              type="button"
              onClick={() => onFix(card)}
              className="flex h-8.5 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 dark:bg-amber-500/15 px-3 text-[12px] font-bold text-amber-700 dark:text-amber-300 shadow-2xs hover:bg-amber-500/20 transition-all cursor-pointer"
              title="Mở popup xử lý báo lỗi & sửa thông tin ảnh"
            >
              <Wrench className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              <span>Xử lý & Sửa ảnh</span>
            </button>
          ) : onEditAsset ? (
            <button
              type="button"
              onClick={() => onEditAsset(card.media_asset_id)}
              disabled={isLoadingAsset}
              className="flex h-8.5 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-semibold text-text-1 shadow-2xs hover:bg-surface-2 hover:border-border-strong transition-all cursor-pointer disabled:opacity-50"
              title="Mở chi tiết ảnh để sửa metadata / SKU trực tiếp tại đây"
            >
              {isLoadingAsset ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-verity" />
              ) : (
                <Wrench className="h-3.5 w-3.5 text-text-2" />
              )}
              <span>Sửa ảnh này</span>
            </button>
          ) : (
            <Link
              href={`/library?asset=${card.media_asset_id}`}
              className="flex h-8.5 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-semibold text-text-1 shadow-2xs hover:bg-surface-2 hover:border-border-strong transition-all cursor-pointer"
              title="Mở Detail Drawer trong thư viện để sửa metadata"
            >
              <span>Sửa ảnh này</span>
              <ArrowUpRight className="h-3.5 w-3.5 text-text-3" />
            </Link>
          )}

          {hasOpenReports ? (
            <>
              {/* Đang xử lý */}
              <button
                type="button"
                onClick={handleSetInReview}
                disabled={isProcessingAction}
                className="flex h-8.5 items-center gap-1 rounded-lg border border-blue-200 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/30 px-2.5 text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-100/70 transition-all cursor-pointer disabled:opacity-50"
              >
                {isProcessingAction ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Clock className="h-3 w-3" />
                )}
                <span>Đang xử lý</span>
              </button>

              {/* Đã xử lý */}
              <button
                type="button"
                onClick={() =>
                  setResolveDialogState({ isOpen: true, targetStatus: 'resolved' })
                }
                disabled={isProcessingAction}
                className="flex h-8.5 items-center gap-1 rounded-lg bg-emerald-600 px-3 text-[12px] font-bold text-white shadow-2xs hover:bg-emerald-700 transition-all cursor-pointer disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Đã xử lý</span>
              </button>

              {/* Bỏ qua */}
              <button
                type="button"
                onClick={() =>
                  setResolveDialogState({ isOpen: true, targetStatus: 'dismissed' })
                }
                disabled={isProcessingAction}
                className="flex h-8.5 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-[12px] font-semibold text-text-3 hover:bg-surface-2 hover:text-text-1 transition-all cursor-pointer disabled:opacity-50"
              >
                <EyeOff className="h-3 w-3" />
                <span>Bỏ qua</span>
              </button>
            </>
          ) : (
            /* Reopen action */
            <button
              type="button"
              onClick={handleReopen}
              disabled={isProcessingAction}
              className="flex h-8.5 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-semibold text-text-2 hover:bg-surface-2 transition-all cursor-pointer disabled:opacity-50"
            >
              {isProcessingAction ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              <span>Mở lại</span>
            </button>
          )}
        </div>
      </div>

      {/* Reports List */}
      <div className="divide-y divide-border bg-surface">
        {card.reports.map((report) => (
          <div key={report.id} className="p-4 sm:px-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-[12.5px]">
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <ReportReasonBadge reason={report.report_reason} />
                <ReportStatusBadge status={report.status} />

                {/* Reporter info */}
                <span className="flex items-center gap-1 text-[11.5px] text-text-3">
                  <User className="h-3 w-3 text-text-3" />
                  <span>{report.reported_by_name || report.reported_by_email || 'Thành viên'}</span>
                </span>

                <span className="text-[11px] text-text-3">
                  · {formatDate(report.created_at)}
                </span>
              </div>

              {/* Note */}
              {report.report_note && (
                <p className="text-[12.5px] text-text-1 bg-surface-2/60 rounded-lg px-3 py-1.5 border border-border/80">
                  {report.report_note}
                </p>
              )}

              {/* Resolution Note if present */}
              {report.resolution_note && (
                <p className="text-[11.5px] text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-950/20 rounded-md px-2.5 py-1 border border-emerald-500/20">
                  <span className="font-semibold">Giải quyết:</span> {report.resolution_note}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Resolve Dialog */}
      <ReportResolveDialog
        isOpen={resolveDialogState.isOpen}
        reportIds={openReportIds}
        targetStatus={resolveDialogState.targetStatus}
        onClose={() =>
          setResolveDialogState((prev) => ({ ...prev, isOpen: false }))
        }
        onSuccess={() => onRefresh()}
      />
    </div>
  );
}
