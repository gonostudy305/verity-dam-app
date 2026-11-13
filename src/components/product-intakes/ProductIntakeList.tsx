'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ChevronDown, Image as ImageIcon, Loader2, PackagePlus, RefreshCw } from 'lucide-react';
import { VerityBadge, type BadgeVariant } from '@/components/common/VerityBadge';
import { useToast } from '@/components/common/Toast';
import { apiRequest } from '@/lib/client/api';
import type { ProductIntake, ProductIntakeReferenceStatus } from '@/types/media';

const STATUS_COPY: Record<ProductIntake['status'], { label: string; variant: BadgeVariant }> = {
  draft: { label: 'Nháp', variant: 'mute' },
  submitted: { label: 'Chờ duyệt', variant: 'ai' },
  needs_changes: { label: 'Cần bổ sung', variant: 'warn' },
  approved: { label: 'Đã đóng', variant: 'ok' },
  rejected: { label: 'Đã từ chối', variant: 'bad' },
};
const REFERENCE_COPY: Record<ProductIntakeReferenceStatus, string> = {
  none: 'Chưa có ảnh mẫu',
  queued: 'Đang chuẩn bị ảnh mẫu',
  ready: 'Ảnh mẫu sẵn sàng',
  failed: 'Ảnh mẫu lỗi',
};

function intakeLabel(intake: ProductIntake): string {
  return intake.proposed_name || intake.selected_product?.display_name || intake.final_sku || intake.proposed_sku || 'Hồ sơ chưa đặt tên';
}

function IntakeRow({ intake }: { intake: ProductIntake }) {
  const status = STATUS_COPY[intake.status];
  const previewAssets = intake.assets.slice(0, 4);
  const overflowCount = intake.assets.length - previewAssets.length;
  return (
    <Link
      href={`/product-intakes/${intake.id}`}
      className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-2xs transition-colors hover:border-border-strong hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
    >
      <div className="flex flex-none -space-x-2">
        {previewAssets.length > 0 ? previewAssets.map((asset) => (
          <div key={asset.media_asset_id} className="h-10 w-10 overflow-hidden rounded-lg border-2 border-surface bg-surface-2">
            {asset.thumbnail_url ? <img src={asset.thumbnail_url} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-text-3"><ImageIcon aria-hidden="true" className="h-3.5 w-3.5" /></div>}
          </div>
        )) : (
          <div className="grid h-10 w-10 place-items-center rounded-lg border border-dashed border-border-strong text-text-3"><ImageIcon aria-hidden="true" className="h-4 w-4" /></div>
        )}
        {overflowCount > 0 ? <span className="grid h-10 w-10 place-items-center rounded-lg border-2 border-surface bg-surface-2 text-[10.5px] font-bold text-text-3">+{overflowCount}</span> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-[13px] font-bold text-text-1">{intakeLabel(intake)}</p>
          <VerityBadge size="sm" variant={status.variant}>{status.label}</VerityBadge>
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-text-2">{intake.final_sku || intake.proposed_sku || 'Chưa có SKU'} · {intake.assets.length} ảnh · {REFERENCE_COPY[intake.reference_status]}</p>
      </div>
    </Link>
  );
}

export function ProductIntakeList() {
  const router = useRouter();
  const { showToast } = useToast();
  const [intakes, setIntakes] = useState<ProductIntake[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const features = await apiRequest<{ product_intakes?: boolean }>('/api/features');
      if (features?.product_intakes !== true) {
        setError('Tính năng Hồ sơ sản phẩm đang tắt trên hệ thống này.');
        setIntakes([]);
        return;
      }
      const response = await apiRequest<{ data: ProductIntake[] }>('/api/product-intakes');
      setIntakes(response.data || []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải danh sách hồ sơ.');
      setIntakes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const createIntake = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await apiRequest<{ data: ProductIntake }>('/api/product-intakes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      router.push(`/product-intakes/${response.data.id}`);
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể tạo hồ sơ mới.', 'warn');
      setCreating(false);
    }
  };

  const open = intakes.filter((intake) => intake.status === 'draft' || intake.status === 'submitted' || intake.status === 'needs_changes');
  const closed = intakes.filter((intake) => intake.status === 'approved' || intake.status === 'rejected');

  return (
    <div className="bg-paper p-3 sm:p-6">
      <div className="mx-auto max-w-[900px] space-y-4 pb-12">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-[16px] font-bold text-text-1">Hồ sơ sản phẩm</h1>
            <p className="mt-0.5 text-[12px] leading-relaxed text-text-2">Khai báo, chạy AI, review và duyệt sản phẩm mới trong cùng một hồ sơ.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border px-3 text-[12px] font-bold text-text-2 transition-colors hover:bg-hover hover:text-text-1">
              <RefreshCw aria-hidden="true" className="h-4 w-4" />Làm mới
            </button>
            <button type="button" disabled={creating} onClick={() => void createIntake()} className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover disabled:cursor-wait disabled:opacity-60">
              <PackagePlus aria-hidden="true" className="h-4 w-4" />{creating ? 'Đang tạo…' : 'Hồ sơ mới'}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="grid min-h-[240px] place-items-center text-[13px] text-text-3"><span className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Đang tải danh sách…</span></div>
        ) : error ? (
          <div className="grid min-h-[240px] place-items-center p-6">
            <div className="max-w-md rounded-2xl border border-warn-border bg-warn-soft/70 p-5 text-center shadow-xs">
              <AlertCircle aria-hidden="true" className="mx-auto h-6 w-6 text-warn" />
              <p className="mt-2 text-[13px] leading-relaxed text-warn">{error}</p>
              <button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-xl border border-warn-border px-4 text-[12.5px] font-bold text-warn transition-colors hover:bg-warn-soft">Thử lại</button>
            </div>
          </div>
        ) : (
          <>
            <section>
              <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-text-3">Đang làm ({open.length})</h2>
              {open.length === 0 ? (
                <div className="grid min-h-[100px] place-items-center rounded-xl border border-dashed border-border-strong p-6 text-center text-[12.5px] text-text-3">Chưa có hồ sơ nào đang xử lý. Bấm &quot;Hồ sơ mới&quot; để bắt đầu.</div>
              ) : (
                <div className="space-y-2">{open.map((intake) => <IntakeRow key={intake.id} intake={intake} />)}</div>
              )}
            </section>
            {closed.length > 0 ? (
              <section>
                <button
                  type="button"
                  onClick={() => setClosedOpen((v) => !v)}
                  className="mb-2 flex w-full items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-text-3 transition-colors hover:text-text-2"
                  aria-expanded={closedOpen}
                >
                  <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform duration-200 ${closedOpen ? 'rotate-180' : ''}`} />
                  Đã đóng ({closed.length})
                </button>
                {closedOpen ? (
                  <div className="space-y-2">{closed.map((intake) => <IntakeRow key={intake.id} intake={intake} />)}</div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
