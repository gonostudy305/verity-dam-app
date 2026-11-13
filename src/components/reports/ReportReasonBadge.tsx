'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { AssetReportReason, AssetReportStatus } from '@/lib/server/asset-reports';

interface ReportReasonBadgeProps {
  reason: AssetReportReason | string;
  className?: string;
}

const REASON_CONFIG: Record<
  AssetReportReason,
  { label: string; bg: string; text: string; border: string }
> = {
  wrong_sku: {
    label: 'Sai SKU',
    bg: 'bg-rose-500/10 dark:bg-rose-500/15',
    text: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-500/30',
  },
  wrong_recognition: {
    label: 'Nhận diện sai',
    bg: 'bg-amber-500/10 dark:bg-amber-500/15',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/30',
  },
  wrong_url: {
    label: 'Link lỗi',
    bg: 'bg-indigo-500/10 dark:bg-indigo-500/15',
    text: 'text-indigo-600 dark:text-indigo-400',
    border: 'border-indigo-500/30',
  },
  other: {
    label: 'Khác',
    bg: 'bg-slate-500/10 dark:bg-slate-500/15',
    text: 'text-slate-600 dark:text-slate-400',
    border: 'border-slate-500/30',
  },
};

export function ReportReasonBadge({ reason, className }: ReportReasonBadgeProps) {
  const config =
    REASON_CONFIG[reason as AssetReportReason] || {
      label: reason,
      bg: 'bg-surface-2',
      text: 'text-text-2',
      border: 'border-border',
    };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none',
        config.bg,
        config.text,
        config.border,
        className
      )}
    >
      {config.label}
    </span>
  );
}

interface ReportStatusBadgeProps {
  status: AssetReportStatus | string;
  className?: string;
}

const STATUS_CONFIG: Record<
  AssetReportStatus,
  { label: string; bg: string; text: string; border: string }
> = {
  open: {
    label: 'Chờ xử lý',
    bg: 'bg-amber-500/10 dark:bg-amber-500/15',
    text: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/30',
  },
  in_review: {
    label: 'Đang xử lý',
    bg: 'bg-blue-500/10 dark:bg-blue-500/15',
    text: 'text-blue-600 dark:text-blue-400',
    border: 'border-blue-500/30',
  },
  resolved: {
    label: 'Đã xử lý',
    bg: 'bg-emerald-500/10 dark:bg-emerald-500/15',
    text: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500/30',
  },
  dismissed: {
    label: 'Đã bỏ qua',
    bg: 'bg-slate-500/10 dark:bg-slate-500/15',
    text: 'text-slate-600 dark:text-slate-400',
    border: 'border-slate-500/30',
  },
};

export function ReportStatusBadge({ status, className }: ReportStatusBadgeProps) {
  const config =
    STATUS_CONFIG[status as AssetReportStatus] || {
      label: status,
      bg: 'bg-surface-2',
      text: 'text-text-2',
      border: 'border-border',
    };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-none',
        config.bg,
        config.text,
        config.border,
        className
      )}
    >
      {config.label}
    </span>
  );
}
