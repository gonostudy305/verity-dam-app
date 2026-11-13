'use client';

import { Layers, X } from 'lucide-react';

export function DuplicatesBulkBar({ count, onResolve, onClear, busy }: { count: number; onResolve: (resolution: 'keep_all' | 'not_duplicate') => void; onClear: () => void; busy: boolean }) {
  return <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-verity/30 bg-surface px-4 py-3 shadow-xl"><div className="flex items-center gap-2 text-[12px] font-semibold text-text-1"><Layers className="h-4 w-4 text-verity-fg" />Đã chọn {count} nhóm · không có thao tác xoá hàng loạt</div><div className="flex flex-wrap items-center gap-2"><button type="button" onClick={onClear} className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-text-2 hover:bg-hover"><X className="h-3.5 w-3.5" />Bỏ chọn</button><button type="button" onClick={() => onResolve('not_duplicate')} disabled={busy} className="min-h-11 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-text-2 hover:bg-hover disabled:opacity-50">Không phải ảnh trùng</button><button type="button" onClick={() => onResolve('keep_all')} disabled={busy} className="min-h-11 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-text-2 hover:bg-hover disabled:opacity-50">Giữ cả nhóm</button></div></div>;
}
