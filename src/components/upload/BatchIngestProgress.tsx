'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2 } from 'lucide-react';
import { apiRequest } from '@/lib/client/api';
import { batchProgressPercent, shouldKeepPolling, type BatchSummary } from '@/lib/ingest-batch';

const POLL_INTERVAL_MS = 3_000;

interface BatchIngestProgressProps {
  batchId: string;
  /** Số ảnh dự kiến của cả lô (làm mẫu số khi ảnh còn đang upload). */
  expectedTotal: number;
  /** Còn đang upload: tiếp tục theo dõi dù chưa có ảnh nào trong DB. */
  uploading: boolean;
}

export function BatchIngestProgress({ batchId, expectedTotal, uploading }: BatchIngestProgressProps) {
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      let keepGoing = true;
      try {
        const response = await apiRequest<{ data: BatchSummary }>(`/api/ingest/batches/${batchId}`);
        if (cancelled) return;
        setSummary(response.data);
        setConnectionLost(false);
        keepGoing = shouldKeepPolling(response.data, uploading);
      } catch {
        // Ảnh đã nằm trong hàng đợi; lỗi mạng tạm thời không phải lỗi xử lý.
        if (cancelled) return;
        setConnectionLost(true);
      }
      if (keepGoing && !cancelled) timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, uploading]);

  if (!summary) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-[12.5px] text-text-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Đang lấy tiến độ lô…
      </div>
    );
  }

  const percent = batchProgressPercent(summary, expectedTotal);
  const waiting = summary.queued + summary.processing;
  const done = summary.finished && !uploading;
  // Upload đã kết thúc mà chưa có ảnh nào vào hệ thống: không có gì để phân tích.
  const empty = summary.total === 0 && !uploading;
  const stats: Array<{ label: string; value: number; tone?: string }> = [
    { label: 'Đã vào hệ thống', value: summary.total },
    { label: 'Đang chờ/phân tích', value: waiting },
    { label: 'Sẵn sàng duyệt', value: summary.ready, tone: 'text-ok' },
    { label: 'Lỗi', value: summary.failed, tone: summary.failed > 0 ? 'text-bad' : undefined },
    { label: 'Cần kiểm tra', value: summary.blocked, tone: summary.blocked > 0 ? 'text-warn' : undefined },
    { label: 'Ảnh trùng', value: summary.duplicates },
    { label: 'Đã gắn SKU', value: summary.with_sku },
    { label: 'Chưa có SKU', value: summary.without_sku },
  ];

  return (
    <section aria-label="Tiến độ lô nhập thư mục" className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-2xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-[14px] font-bold text-text-1">
          {done ? (
            <CheckCircle2 className="h-4 w-4 text-ok" />
          ) : empty ? (
            <AlertTriangle className="h-4 w-4 text-warn" />
          ) : (
            <Loader2 className="h-4 w-4 animate-spin text-text-3" />
          )}
          {done
            ? 'Lô đã xử lý xong'
            : empty
              ? 'Chưa có ảnh nào vào hệ thống (xem lỗi từng nhóm bên dưới)'
              : uploading
                ? 'Đang tải lên và phân tích…'
                : 'AI đang phân tích…'}
        </h4>
        <span className="font-mono text-[12px] text-text-3" data-testid="batch-percent">{percent}%</span>
      </div>

      <div
        className="h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-verity transition-all" style={{ width: `${percent}%` }} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label}>
            <dt className="text-[11px] text-text-3">{stat.label}</dt>
            <dd className={`font-mono text-[15px] font-bold ${stat.tone ?? 'text-text-1'}`}>{stat.value}</dd>
          </div>
        ))}
      </dl>

      {connectionLost ? (
        <p className="flex items-center gap-1.5 text-[12px] text-warn">
          <AlertTriangle className="h-3.5 w-3.5" />
          Mất kết nối tạm thời, đang thử lại. Ảnh đã tải lên không bị ảnh hưởng.
        </p>
      ) : null}

      {summary.ready > 0 ? (
        <Link href="/review" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-verity px-4 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-verity-hover">
          <span>Mở hàng duyệt</span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      ) : null}
    </section>
  );
}
