'use client';

import { CheckCircle2, RotateCcw } from 'lucide-react';
import type { BatchResolveReport } from '@/types/dedup';

function protectedLabel(entry: unknown) {
  if (!entry || typeof entry !== 'object') return 'Asset cần xem lại';
  const value = entry as { title?: unknown; reasons?: unknown };
  const title = typeof value.title === 'string' && value.title ? value.title : 'Asset';
  const reasons = Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === 'string').join(', ') : 'có ràng buộc';
  return `${title}: ${reasons}`;
}

export function BatchResolveResultPanel({ report, onUndo }: { report: BatchResolveReport; onUndo: (clusterId: string) => void }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-bold text-text-1"><CheckCircle2 className="h-4 w-4 text-good" />Kết quả batch</div>
      <p className="mt-1 text-xs text-text-3">Đã xử lý {report.resolved.length} cluster · {report.removed_asset_ids.length} asset · bỏ qua {report.skipped.length} cluster.</p>
      {report.resolved.length > 0 && <div className="mt-3 space-y-2">{report.resolved.map((item) => <div key={item.cluster_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-good-soft px-3 py-2 text-xs text-good"><span>{item.cluster_id.slice(0, 8)} · đã xử lý</span><button type="button" onClick={() => onUndo(item.cluster_id)} className="inline-flex items-center gap-1 font-semibold hover:underline"><RotateCcw className="h-3.5 w-3.5" />Hoàn tác</button></div>)}</div>}
      {report.skipped.length > 0 && <div className="mt-3 space-y-2">{report.skipped.map((item) => <div key={item.cluster_id} className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn"><p>{item.cluster_id.slice(0, 8)} · bỏ qua: {item.code}</p>{Array.isArray(item.protected) && item.protected.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{item.protected.map((entry, index) => <li key={index}>{protectedLabel(entry)}</li>)}</ul>}</div>)}</div>}
    </section>
  );
}
