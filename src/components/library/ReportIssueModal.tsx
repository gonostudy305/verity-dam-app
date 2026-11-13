'use client';

import React, { useState } from 'react';
import { AlertCircle, Flag, Loader2, X } from 'lucide-react';
import { apiRequest, ClientApiError } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { AssetReportReason } from '@/lib/server/asset-reports';

interface ReportIssueModalProps {
  assetIds: string[];
  isOpen: boolean;
  onClose: () => void;
  onReported: (count: number) => void;
}

const REPORT_REASONS: {
  value: AssetReportReason;
  label: string;
  description: string;
}[] = [
  {
    value: 'wrong_sku',
    label: 'Sai SKU',
    description: 'Mã sản phẩm hoặc biến thể không chính xác',
  },
  {
    value: 'wrong_recognition',
    label: 'AI nhận diện / mô tả sai',
    description: 'Tên, nhãn hoặc ngữ cảnh nhận dạng chưa đúng',
  },
  {
    value: 'wrong_url',
    label: 'Link ảnh sai hoặc hỏng',
    description: 'Không mở được ảnh hoặc ảnh bị lỗi tải',
  },
  {
    value: 'other',
    label: 'Khác',
    description: 'Mô tả chi tiết lỗi trong phần ghi chú bên dưới',
  },
];

export function ReportIssueModal({
  assetIds,
  isOpen,
  onClose,
  onReported,
}: ReportIssueModalProps) {
  const [selectedReason, setSelectedReason] = useState<AssetReportReason>('wrong_sku');
  const [reportNote, setReportNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || assetIds.length === 0) return null;

  const count = assetIds.length;
  const isOther = selectedReason === 'other';
  const isNoteEmpty = reportNote.trim().length === 0;
  const isFormInvalid = isOther && isNoteEmpty;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isFormInvalid || isSubmitting) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await apiRequest<{
        success: boolean;
        data: { created: number; report_ids: string[] };
      }>('/api/asset-reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          media_asset_ids: assetIds,
          report_reason: selectedReason,
          report_note: reportNote.trim() ? reportNote.trim() : null,
        }),
      });

      onReported(res.data.created);
    } catch (err) {
      if (err instanceof ClientApiError) {
        setErrorMessage(err.message);
      } else if (err instanceof Error) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Không thể gửi báo lỗi. Vui lòng thử lại.');
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
        className="w-full max-w-[480px] rounded-2xl border border-border bg-surface shadow-pop overflow-hidden animate-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-surface-2/60">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
              <Flag className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-[14.5px] font-bold text-text-1">
                {count === 1 ? 'Báo lỗi ảnh' : `Báo lỗi ${count} ảnh`}
              </h3>
              <p className="text-[11.5px] text-text-3">
                Báo lỗi để reviewer kiểm tra và hiệu chỉnh
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng modal"
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

          {/* Reason Selection */}
          <div className="space-y-2">
            <label className="block text-[12.5px] font-semibold text-text-1">
              Lý do báo lỗi <span className="text-red-500">*</span>
            </label>
            <div className="grid grid-cols-1 gap-2">
              {REPORT_REASONS.map((reason) => {
                const isSelected = selectedReason === reason.value;
                return (
                  <label
                    key={reason.value}
                    className={cn(
                      'flex items-start gap-3 p-3 rounded-xl border text-left cursor-pointer transition-all',
                      isSelected
                        ? 'border-amber-500 bg-amber-500/5 dark:bg-amber-500/10'
                        : 'border-border bg-surface hover:bg-surface-2 hover:border-border-strong'
                    )}
                  >
                    <input
                      type="radio"
                      name="report_reason"
                      value={reason.value}
                      checked={isSelected}
                      onChange={() => setSelectedReason(reason.value)}
                      className="mt-0.5 accent-amber-500 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-text-1">
                        {reason.label}
                      </div>
                      <div className="text-[11.5px] text-text-3 mt-0.5">
                        {reason.description}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Note Input */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="block text-[12.5px] font-semibold text-text-1">
                Ghi chú chi tiết {isOther && <span className="text-red-500">* (bắt buộc)</span>}
              </label>
              <span className="text-[11px] text-text-3">
                {reportNote.length}/1000
              </span>
            </div>
            <textarea
              rows={3}
              value={reportNote}
              onChange={(e) => setReportNote(e.target.value.slice(0, 1000))}
              placeholder={
                isOther
                  ? 'Vui lòng mô tả chi tiết vấn đề phát hiện để reviewer xử lý...'
                  : 'Ghi chú thêm nếu cần (không bắt buộc)...'
              }
              className={cn(
                'w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-1 placeholder:text-text-3 focus:border-amber-500 focus:outline-hidden focus:ring-1 focus:ring-amber-500 resize-none transition-colors',
                isOther && isNoteEmpty && 'border-amber-500/60'
              )}
            />
            {isOther && isNoteEmpty && (
              <p className="text-[11.5px] text-amber-600 dark:text-amber-400 font-medium">
                Vui lòng nhập nội dung mô tả khi chọn lý do Khác.
              </p>
            )}
          </div>

          {/* Actions */}
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
              disabled={isFormInvalid || isSubmitting}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-[12.5px] font-bold text-white shadow-xs hover:bg-amber-600 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang gửi...</span>
                </>
              ) : (
                <>
                  <Flag className="h-3.5 w-3.5" />
                  <span>Gửi báo lỗi</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
