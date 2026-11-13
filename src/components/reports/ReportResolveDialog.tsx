'use client';

import React, { useState } from 'react';
import { CheckCircle2, EyeOff, Loader2, X, AlertCircle } from 'lucide-react';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { AssetReportStatus } from '@/lib/server/asset-reports';

interface ReportResolveDialogProps {
  isOpen: boolean;
  reportIds: string[];
  targetStatus: 'resolved' | 'dismissed';
  defaultResolutionNote?: string;
  onClose: () => void;
  onSuccess: (updatedCount: number) => void;
}

export function ReportResolveDialog({
  isOpen,
  reportIds,
  targetStatus,
  defaultResolutionNote = '',
  onClose,
  onSuccess,
}: ReportResolveDialogProps) {
  const [resolutionNote, setResolutionNote] = useState(defaultResolutionNote);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  React.useEffect(() => {
    if (isOpen) {
      setResolutionNote(defaultResolutionNote);
      setErrorMessage(null);
    }
  }, [isOpen, defaultResolutionNote]);

  if (!isOpen || reportIds.length === 0) return null;

  const isResolved = targetStatus === 'resolved';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await apiRequest<{
        success: boolean;
        data: { updated: number };
      }>('/api/asset-reports', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          report_ids: reportIds,
          status: targetStatus,
          resolution_note: resolutionNote.trim() ? resolutionNote.trim() : null,
        }),
      });

      onSuccess(res.data.updated);
      onClose();
    } catch (err) {
      if (err instanceof ClientApiError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Không thể cập nhật trạng thái báo cáo.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] rounded-2xl border border-border bg-surface shadow-pop overflow-hidden animate-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-surface-2/60">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'grid h-8 w-8 place-items-center rounded-lg border',
                isResolved
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                  : 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'
              )}
            >
              {isResolved ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}
            </div>
            <div>
              <h3 className="text-[14.5px] font-bold text-text-1">
                {isResolved ? 'Đánh dấu đã xử lý' : 'Bỏ qua báo lỗi'}
              </h3>
              <p className="text-[11.5px] text-text-3">
                {reportIds.length} báo cáo sẽ được cập nhật
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng dialog"
            className="grid h-8 w-8 place-items-center rounded-lg text-text-3 transition-colors hover:bg-hover hover:text-text-1 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200/80 bg-red-50/80 dark:bg-red-950/40 p-3 text-[12px] text-red-600 dark:text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="flex-1">{errorMessage}</span>
            </div>
          )}

          <p className="text-[12.5px] text-text-2 leading-relaxed">
            {isResolved
              ? 'Xác nhận sự cố đã được điều chỉnh. Các báo cáo lỗi của ảnh này sẽ được đóng lại.'
              : 'Bỏ qua báo cáo lỗi này nếu kiểm tra thấy ảnh và thông tin đã chính xác.'}
          </p>

          <div className="space-y-1.5">
            <label className="block text-[12.5px] font-semibold text-text-1">
              Ghi chú xử lý <span className="text-text-3 font-normal">(tùy chọn)</span>
            </label>
            <textarea
              rows={3}
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value.slice(0, 1000))}
              placeholder={
                isResolved
                  ? 'Ví dụ: Đã sửa SKU sang bản quốc tế, đã cập nhật nhãn...'
                  : 'Lý do bỏ qua báo lỗi...'
              }
              className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-1 placeholder:text-text-3 focus:border-verity focus:outline-hidden focus:ring-1 focus:ring-verity resize-none transition-colors"
            />
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl border border-border px-4 py-2 text-[12.5px] font-semibold text-text-2 hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-60"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={cn(
                'flex items-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-bold text-white shadow-xs transition-all cursor-pointer disabled:opacity-50',
                isResolved
                  ? 'bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98]'
                  : 'bg-slate-700 hover:bg-slate-800 active:scale-[0.98]'
              )}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang lưu...</span>
                </>
              ) : isResolved ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Xác nhận đã xử lý</span>
                </>
              ) : (
                <>
                  <EyeOff className="h-3.5 w-3.5" />
                  <span>Bỏ qua báo lỗi</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
