'use client';

import { AlertTriangle, Check, Clock, ShieldAlert, X } from 'lucide-react';
import type { ReviewQueueItem } from '@/types/media';
import { ResponsiveDialogClose, ResponsiveDialogSheet } from '@/components/common/interaction-primitives';
import { summariseReviewSelection } from './review-card-signals';

type BatchDecision = 'approved' | 'rejected' | 'skipped';

const COPY: Record<BatchDecision, { title: string; description: string; action: string; tone: string }> = {
  approved: {
    title: 'Xác nhận duyệt hàng loạt',
    description: 'Các ảnh sẽ được chuyển vào Thư viện. Không có hoàn tác sau khi duyệt.',
    action: 'Xác nhận duyệt', tone: 'bg-verity hover:bg-verity-hover text-white',
  },
  rejected: {
    title: 'Xác nhận từ chối hàng loạt',
    description: 'Các ảnh sẽ bị từ chối khỏi hàng chờ. Không có hoàn tác sau khi từ chối.',
    action: 'Xác nhận từ chối', tone: 'bg-warn hover:brightness-95 text-white',
  },
  skipped: {
    title: 'Chuyển ảnh sang Để sau',
    description: 'Các ảnh vẫn được giữ nguyên và có thể mở lại từ tab Để sau.',
    action: 'Chuyển sang Để sau', tone: 'bg-text-2 hover:bg-text-1 text-white',
  },
};

export function ReviewDecisionConfirm({
  open,
  decision,
  items,
  submitting = false,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  decision: BatchDecision;
  items: ReviewQueueItem[];
  submitting?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const summary = summariseReviewSelection(items);
  const copy = COPY[decision];
  const rows = [
    { label: decision === 'approved' ? 'ảnh sẽ chuyển vào Thư viện' : decision === 'rejected' ? 'ảnh sẽ bị từ chối' : 'ảnh sẽ chuyển sang Để sau', value: summary.total, icon: Check },
    { label: 'ảnh có confidence cần chú ý', value: summary.lowConfidence, icon: ShieldAlert },
    { label: 'ảnh thiếu SKU', value: summary.missingSku, icon: AlertTriangle },
    { label: 'ảnh nghi trùng lặp — vẫn giữ cả hai bản', value: summary.duplicates, icon: AlertTriangle },
  ];

  return (
    <ResponsiveDialogSheet open={open} onOpenChange={onOpenChange} title={copy.title} description={copy.description} variant="dialog">
      <div className="space-y-3">
        <div className="overflow-hidden rounded-xl border border-border">
          {rows.map(({ label, value, icon: Icon }) => (
            <div key={label} className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0">
              <Icon className="h-4 w-4 flex-none text-text-3" />
              <span className="min-w-0 flex-1 text-[12px] text-text-2">{label}</span>
              <strong className="text-[14px] text-text-1">{value}</strong>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <ResponsiveDialogClose>
            <button type="button" disabled={submitting} className="min-h-11 flex-1 rounded-xl border border-border px-3 text-[12.5px] font-bold text-text-2 hover:bg-hover disabled:opacity-50">Quay lại</button>
          </ResponsiveDialogClose>
          <button type="button" onClick={onConfirm} disabled={submitting || summary.total === 0} className={`min-h-11 flex-[1.35] rounded-xl px-3 text-[12.5px] font-bold shadow-sm disabled:opacity-50 ${copy.tone}`}>
            {submitting ? 'Đang lưu…' : copy.action}
          </button>
        </div>
      </div>
    </ResponsiveDialogSheet>
  );
}
