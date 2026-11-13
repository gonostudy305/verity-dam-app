'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, ChevronDown, Globe, Image as ImageIcon, Loader2, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { VerityBadge, type BadgeVariant } from '@/components/common/VerityBadge';
import { VerityChip } from '@/components/common/VerityChip';
import { useToast } from '@/components/common/Toast';
import { apiRequest } from '@/lib/client/api';
import type { CatalogProductSearchResult, ProductIntake, ProductIntakeAssetDecision, ProductIntakeDecision, ProductIntakeReferenceStatus } from '@/types/media';

interface ProductIntakeReviewPanelProps {
  active?: boolean;
}

type ReferenceRole = 'HERO' | 'ANGLE';
type ImageCategory = 'REAL' | 'STUDIO' | 'DESIGN';
type AssetChoice = {
  decision: Exclude<ProductIntakeAssetDecision, 'pending'>;
  isReference: boolean;
  role?: ReferenceRole;
  imageCategory?: ImageCategory;
};

const ROLE_OPTIONS: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'HERO', label: 'Ảnh chính' },
  { value: 'ANGLE', label: 'Ảnh góc' },
];
const IMAGE_CATEGORY_OPTIONS: Array<{ value: ImageCategory; label: string }> = [
  { value: 'REAL', label: 'Ảnh thực tế' },
  { value: 'STUDIO', label: 'Ảnh Studio' },
  { value: 'DESIGN', label: 'Ảnh Thiết kế' },
];

function asRole(value?: string | null): ReferenceRole | undefined {
  return value === 'HERO' || value === 'ANGLE' ? value : undefined;
}
function asImageCategory(value?: string | null): ImageCategory | undefined {
  return value === 'REAL' || value === 'STUDIO' || value === 'DESIGN' ? value : undefined;
}

/** Domain là thứ reviewer cần liếc để đánh giá bản quyền, không phải cả URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function fmtDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const referenceStatusCopy: Record<ProductIntakeReferenceStatus, { label: string; variant: BadgeVariant }> = {
  none: { label: 'Chưa có ảnh mẫu', variant: 'mute' },
  queued: { label: 'Đang chuẩn bị', variant: 'ai' },
  ready: { label: 'Sẵn sàng nhận diện', variant: 'ok' },
  failed: { label: 'Cần thử lại', variant: 'bad' },
};

const DECISION_ACTION_LABEL: Record<string, string> = {
  created: 'Tạo hồ sơ',
  submitted: 'Gửi duyệt',
  needs_changes: 'Yêu cầu bổ sung',
  approved: 'Duyệt hồ sơ',
  rejected: 'Từ chối hồ sơ',
  reference_retry: 'Thử lại ảnh mẫu',
};

/** Lịch sử rút gọn -- chỉ các mốc reviewer cần biết trước khi ra quyết định,
 * không phải audit log đầy đủ (payload/revision không hiển thị ở đây). */
function IntakeDecisionHistory({ decisions }: { decisions: ProductIntakeDecision[] }) {
  if (decisions.length === 0) return null;
  return (
    <details className="mt-4 rounded-xl border border-border/70 bg-surface-2/30 p-3">
      <summary className="cursor-pointer select-none text-[11.5px] font-bold text-text-2 hover:text-text-1">Lịch sử xử lý ({decisions.length})</summary>
      <ol className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
        {decisions.map((entry, index) => (
          <li key={index} className="text-[11px] leading-relaxed text-text-2">
            <span className="font-semibold text-text-1">{DECISION_ACTION_LABEL[entry.action] || entry.action}</span>
            {entry.actor?.name || entry.actor?.email ? ` · ${entry.actor?.name || entry.actor?.email}` : ''}
            {fmtDate(entry.created_at) ? ` · ${fmtDate(entry.created_at)}` : ''}
            {entry.note ? <span className="block text-text-3">"{entry.note}"</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function intakeTitle(intake: ProductIntake) {
  return intake.proposed_name || intake.final_sku || intake.proposed_sku || 'Sản phẩm chưa đặt tên';
}

function statusCopy(status: ProductIntake['status']) {
  const copy: Record<ProductIntake['status'], string> = {
    draft: 'Nháp',
    submitted: 'Chờ duyệt',
    needs_changes: 'Cần bổ sung',
    approved: 'Đã duyệt',
    rejected: 'Đã từ chối',
  };
  return copy[status];
}

function initialChoices(intake: ProductIntake): Record<string, AssetChoice> {
  return Object.fromEntries(intake.assets.map((asset) => [asset.media_asset_id, {
    decision: asset.decision === 'rejected' ? 'rejected' : 'approved',
    // The worker only creates an embedding from a completed ingest. Keep the
    // contributor's suggestion as a visual hint, but never send an impossible
    // reference decision that the server must reject.
    isReference: Boolean(asset.is_reference || asset.proposed_reference)
      && asset.ingest_status === 'ready'
      && ['photo', 'render', 'screenshot'].includes(String(asset.media_type)),
    role: asRole(asset.confirmed_role) || asRole(asset.proposed_role),
    imageCategory: asImageCategory(asset.confirmed_image_category) || asImageCategory(asset.proposed_image_category),
  }]));
}

export function ProductIntakeReviewPanel({ active = false }: ProductIntakeReviewPanelProps) {
  const { showToast } = useToast();
  const [intakes, setIntakes] = useState<ProductIntake[]>([]);
  const [approvedIntakes, setApprovedIntakes] = useState<ProductIntake[]>([]);
  const [resolved, setResolved] = useState<ProductIntake[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [submittedResponse, approvedResponse] = await Promise.all([
        apiRequest<{ data: ProductIntake[] }>('/api/product-intakes?status=submitted'),
        apiRequest<{ data: ProductIntake[] }>('/api/product-intakes?status=approved'),
      ]);
      setIntakes(submittedResponse.data || []);
      setApprovedIntakes((approvedResponse.data || []).slice(0, 8));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể tải hồ sơ sản phẩm.');
      setIntakes([]);
      setApprovedIntakes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  if (loading) {
    return <div className="grid h-full min-h-[300px] place-items-center text-[13px] text-text-3"><span className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Đang tải hồ sơ sản phẩm…</span></div>;
  }

  if (error) {
    return (
      <div className="grid h-full min-h-[300px] place-items-center p-6">
        <div className="max-w-md rounded-2xl border border-warn-border bg-warn-soft/70 p-5 text-center shadow-xs">
          <AlertCircle aria-hidden="true" className="mx-auto h-6 w-6 text-warn" />
          <p className="mt-2 text-[13px] leading-relaxed text-warn">{error}</p>
          <button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-xl border border-warn-border px-4 text-[12.5px] font-bold text-warn transition-colors hover:bg-warn-soft">Thử lại</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper p-3 sm:p-6">
      <div className="mx-auto max-w-[1200px] space-y-4">
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[16px] font-bold text-text-1">Hồ sơ sản phẩm</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-text-2">Chốt danh tính, giữ hoặc loại từng ảnh, sau đó chọn ảnh mẫu để chuẩn bị nhận diện.</p>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border px-3.5 text-[12.5px] font-bold text-text-2 transition-colors hover:bg-hover hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity">
            <RefreshCw aria-hidden="true" className="h-4 w-4" />Làm mới
          </button>
        </div>

        {intakes.length === 0 ? (
          <div className="grid min-h-[280px] place-items-center rounded-2xl border border-dashed border-border-strong bg-surface p-8 text-center">
            <div>
              <ShieldCheck aria-hidden="true" className="mx-auto h-8 w-8 text-ok" />
              <h3 className="mt-3 text-[15px] font-bold text-text-1">Chưa có hồ sơ chờ duyệt</h3>
              <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-text-2">Các hồ sơ được contributor gửi từ màn hình Upload sẽ xuất hiện tại đây.</p>
            </div>
          </div>
        ) : intakes.map((intake) => (
          <IntakeReviewCard
            key={intake.id}
            intake={intake}
            onResolved={(updated) => {
              setIntakes((current) => current.filter((entry) => entry.id !== intake.id));
              setResolved((current) => [updated, ...current.filter((entry) => entry.id !== updated.id)].slice(0, 4));
            }}
          />
        ))}

        {resolved.length > 0 ? (
          <section aria-labelledby="resolved-intakes-heading" className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
            <h3 id="resolved-intakes-heading" className="text-[13px] font-bold text-text-1">Đã xử lý trong phiên này</h3>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {resolved.map((intake) => <ResolvedIntakeCard key={intake.id} intake={intake} />)}
            </div>
          </section>
        ) : null}

        {approvedIntakes.length > 0 ? (
          <section aria-labelledby="reference-status-heading" className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><h3 id="reference-status-heading" className="text-[13px] font-bold text-text-1">Trạng thái ảnh mẫu</h3><p className="mt-0.5 text-[11px] text-text-3">Các hồ sơ đã duyệt gần đây. Có thể thử lại khi tạo reference thất bại.</p></div>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {approvedIntakes.map((intake) => <ResolvedIntakeCard key={intake.id} intake={intake} />)}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function IntakeReviewCard({ intake, onResolved }: { intake: ProductIntake; onResolved: (intake: ProductIntake) => void }) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(true);
  const [choices, setChoices] = useState<Record<string, AssetChoice>>(() => initialChoices(intake));
  const [finalSku, setFinalSku] = useState(intake.final_sku || intake.proposed_sku || '');
  const [reviewerNote, setReviewerNote] = useState(intake.reviewer_note || '');
  const [submitting, setSubmitting] = useState(false);

  const keptCount = useMemo(() => Object.values(choices).filter((choice) => choice.decision === 'approved').length, [choices]);
  const referenceCount = useMemo(() => Object.values(choices).filter((choice) => choice.decision === 'approved' && choice.isReference).length, [choices]);
  const referenceMeta = referenceStatusCopy[intake.reference_status];

  const updateChoice = (assetId: string, patch: Partial<AssetChoice>) => {
    setChoices((current) => {
      const next = { ...current[assetId], ...patch };
      if (next.decision === 'rejected') next.isReference = false;
      return { ...current, [assetId]: next };
    });
  };

  const decide = async (decision: 'approved' | 'needs_changes' | 'rejected') => {
    if (submitting) return;
    if (decision === 'approved') {
      const trimmedSku = finalSku.trim();
      if (!trimmedSku || trimmedSku.length < 3) {
        showToast('Cần chốt SKU (tối thiểu 3 ký tự) trước khi duyệt hồ sơ.', 'warn');
        return;
      }
      if (intake.assets.length === 0 || Object.keys(choices).length !== intake.assets.length) {
        showToast('Hồ sơ chưa có đủ quyết định cho từng ảnh.', 'warn');
        return;
      }
      if (keptCount === 0) {
        showToast('Cần giữ ít nhất một ảnh để duyệt hồ sơ.', 'warn');
        return;
      }
    }

    setSubmitting(true);
    try {
      const response = await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intake.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          expected_revision: intake.revision,
          final_sku: decision === 'approved' ? finalSku.trim() : undefined,
          reviewer_note: reviewerNote.trim() || undefined,
          asset_decisions: decision === 'approved'
            ? intake.assets.map((asset) => {
                const choice = choices[asset.media_asset_id];
                const isReference = choice?.decision === 'approved' && Boolean(choice?.isReference);
                return {
                  media_asset_id: asset.media_asset_id,
                  decision: choice?.decision || 'rejected',
                  is_reference: isReference,
                  role: isReference ? choice?.role : undefined,
                  image_category: isReference ? choice?.imageCategory : undefined,
                };
              })
            : undefined,
        }),
      });
      const updated = response.data || { ...intake, status: decision, final_sku: finalSku.trim() || intake.final_sku };
      onResolved(updated);
      if (decision === 'approved') {
        showToast(referenceCount > 0 ? 'Đã duyệt hồ sơ và đưa ảnh mẫu vào hàng đợi chuẩn bị.' : 'Đã duyệt hồ sơ. Sản phẩm chưa có ảnh mẫu.', 'success');
      } else if (decision === 'needs_changes') {
        showToast('Đã yêu cầu contributor bổ sung hồ sơ.', 'info');
      } else {
        showToast('Đã từ chối hồ sơ sản phẩm.', 'warn');
      }
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể lưu quyết định hồ sơ.', 'warn');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="flex min-h-[60px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-verity">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[14px] font-bold text-text-1">{intakeTitle(intake)}</h3>
            <VerityBadge variant="verity" size="sm">{statusCopy(intake.status)}</VerityBadge>
            <VerityBadge variant={referenceMeta.variant} size="sm" dot>{referenceMeta.label}</VerityBadge>
          </div>
          <p className="mt-0.5 truncate text-[11.5px] text-text-2">{[intake.proposed_brand, intake.proposed_model, intake.proposed_sku].filter(Boolean).join(' · ') || 'Chưa có SKU đề xuất'} · {intake.assets.length} ảnh</p>
          <p className="mt-0.5 truncate text-[11px] text-text-3">Gửi bởi {intake.owner?.name || intake.owner?.email || 'Không rõ'}{fmtDate(intake.submitted_at) ? ` · ${fmtDate(intake.submitted_at)}` : ''}</p>
        </div>
        <ChevronDown aria-hidden="true" className={`h-4 w-4 flex-none text-text-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open ? (
        <div className="border-t border-border p-4 sm:p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
            <div>
              <h4 className="text-[12px] font-bold text-text-2">Thông tin contributor gửi</h4>
              <dl className="mt-2 grid gap-x-4 gap-y-2 text-[12px] sm:grid-cols-2">
                <InfoRow label="Tên" value={intake.proposed_name} />
                <InfoRow label="Hãng" value={intake.proposed_brand} />
                <InfoRow label="Model" value={intake.proposed_model} />
                <InfoRow label="SKU đề xuất" value={intake.proposed_sku} mono />
                <InfoRow label="Danh mục" value={intake.proposed_category} />
                <InfoRow label="Không gian" value={intake.proposed_space} />
                <InfoRow label="Nguồn" value={intake.source_url} link />
                <InfoRow label="Ghi chú" value={intake.notes} />
              </dl>
              {intake.reference_error ? <p className="mt-3 rounded-xl border border-bad-border bg-bad-soft/60 px-3 py-2 text-[11.5px] leading-relaxed text-bad">{intake.reference_error}</p> : null}
            </div>
            <div className="space-y-3 rounded-xl border border-border bg-surface-2/45 p-3">
              <label className="block space-y-1.5">
                <span className="text-[12px] font-bold text-text-2">SKU chốt khi duyệt <span className="text-bad">*</span></span>
                <input
                  value={finalSku}
                  onChange={(event) => setFinalSku(event.target.value.toUpperCase().replace(/\s+/g, '-'))}
                  className="h-11 w-full rounded-xl border border-border bg-surface px-3 font-mono text-[12.5px] text-text-1 outline-none transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20"
                  placeholder="Nhập SKU chính thức"
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[12px] font-bold text-text-2">Ghi chú phản hồi</span>
                <textarea value={reviewerNote} onChange={(event) => setReviewerNote(event.target.value)} rows={2} className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[12px] text-text-1 outline-none transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20" placeholder="Hiển thị cho contributor khi cần bổ sung" />
              </label>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-[12px] font-bold text-text-2">Quyết định theo ảnh</h4>
                <p className="mt-0.5 text-[11px] text-text-3">Chỉ ảnh được giữ mới có thể là ảnh mẫu. Đã giữ: {keptCount}/{intake.assets.length} · Ảnh mẫu: {referenceCount}</p>
              </div>
              {referenceCount === 0 ? <span className="text-[11px] font-medium text-text-3">Duyệt không cần ảnh mẫu</span> : null}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {intake.assets.map((asset) => {
                const choice = choices[asset.media_asset_id] || { decision: 'approved' as const, isReference: false };
                const referenceAssetType = ['photo', 'render', 'screenshot'].includes(String(asset.media_type));
                const referenceEligible = choice.decision === 'approved' && asset.ingest_status === 'ready' && referenceAssetType;
                return (
                  <article key={asset.media_asset_id} className="overflow-hidden rounded-xl border border-border bg-surface-2/35">
                    <div className="flex h-[92px] bg-surface-2">
                      {asset.thumbnail_url ? <img src={asset.thumbnail_url} alt={asset.title || 'Ảnh trong hồ sơ'} className="h-full w-[112px] flex-none object-cover" /> : <div className="grid w-[112px] flex-none place-items-center text-text-3"><ImageIcon aria-hidden="true" className="h-5 w-5" /></div>}
                      <div className="min-w-0 flex-1 p-2.5">
                        <p className="line-clamp-2 text-[11.5px] font-semibold leading-snug text-text-1">{asset.title || 'Ảnh chưa đặt tên'}</p>
                        <p className="mt-1 text-[10.5px] text-text-3">{asset.ingest_status || 'Đã tải lên'}</p>
                        {asset.source_url ? (
                          <p className="mt-1 flex items-center gap-1 text-[10.5px] text-warn">
                            <Globe aria-hidden="true" className="h-3 w-3 flex-none" />
                            <span className="font-semibold">Ảnh từ web</span>
                            <a
                              href={asset.source_url}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              title={asset.source_url}
                              onClick={(event) => event.stopPropagation()}
                              className="min-w-0 truncate underline decoration-dotted hover:text-text-1"
                            >
                              {hostOf(asset.source_url)}
                            </a>
                          </p>
                        ) : null}
                        {asset.sku_match?.sku ? <p className="mt-1 truncate text-[10.5px] text-ai" title={`AI gợi ý: ${asset.sku_match.sku}`}>AI gợi ý: {asset.sku_match.sku}{asset.sku_match.requires_reviewer_confirmation ? ' · cần xác minh' : ''}</p> : null}
                        {asset.publish_status === 'published' ? <p className="mt-1 text-[10.5px] font-semibold text-warn">⚠️ Đã xuất bản{fmtDate(asset.published_at) ? ` · ${fmtDate(asset.published_at)}` : ''}</p> : null}
                      </div>
                    </div>
                    <div className="space-y-2 p-2.5">
                      {asset.ingest_error ? <p className="rounded-md border border-bad-border bg-bad-soft/50 px-2 py-1.5 text-[10.5px] leading-snug text-bad">Lỗi xử lý ảnh: {asset.ingest_error}</p> : null}
                      {asset.reference_error ? <p className="rounded-md border border-bad-border bg-bad-soft/50 px-2 py-1.5 text-[10.5px] leading-snug text-bad">Lỗi ảnh mẫu: {asset.reference_error}</p> : null}
                      <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={`Quyết định ảnh ${asset.title || asset.media_asset_id}`}>
                        <button type="button" onClick={() => updateChoice(asset.media_asset_id, { decision: 'approved' })} className={`min-h-11 rounded-lg border px-2 text-[11.5px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity ${choice.decision === 'approved' ? 'border-ok bg-ok-soft text-ok' : 'border-border bg-surface text-text-2 hover:bg-hover'}`}><Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />Giữ</button>
                        <button type="button" onClick={() => updateChoice(asset.media_asset_id, { decision: 'rejected' })} className={`min-h-11 rounded-lg border px-2 text-[11.5px] font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity ${choice.decision === 'rejected' ? 'border-bad bg-bad-soft text-bad' : 'border-border bg-surface text-text-2 hover:bg-hover'}`}><X aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />Loại</button>
                      </div>
                      <label className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-[11.5px] font-semibold ${referenceEligible ? 'cursor-pointer bg-ai-soft/55 text-ai' : 'cursor-not-allowed bg-surface-2 text-text-disabled'}`}>
                        <input type="checkbox" checked={choice.isReference} disabled={!referenceEligible} onChange={(event) => updateChoice(asset.media_asset_id, { isReference: event.target.checked })} className="h-4 w-4 rounded border-border text-verity focus:ring-verity" />
                        {!referenceAssetType ? 'Video không dùng làm ảnh mẫu' : asset.ingest_status === 'ready' ? 'Dùng làm ảnh mẫu' : 'Chờ xử lý xong để làm mẫu'}
                      </label>
                      {referenceEligible && choice.isReference ? (
                        <div className="space-y-1.5 rounded-lg bg-surface-2/60 p-2">
                          {(asset.proposed_role || asset.proposed_image_category || asset.proposed_angle) ? (
                            <p className="text-[10px] leading-snug text-text-3">Contributor đề xuất: {[asRole(asset.proposed_role) && (asset.proposed_role === 'HERO' ? 'Ảnh chính' : 'Ảnh góc'), asImageCategory(asset.proposed_image_category) && IMAGE_CATEGORY_OPTIONS.find((o) => o.value === asset.proposed_image_category)?.label, asset.proposed_angle].filter(Boolean).join(' · ')}</p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-[10px] font-semibold text-text-3">Vai trò</span>
                            {ROLE_OPTIONS.map((option) => (
                              <VerityChip key={option.value} active={choice.role === option.value} onClick={() => updateChoice(asset.media_asset_id, { role: choice.role === option.value ? undefined : option.value })}>{option.label}</VerityChip>
                            ))}
                          </div>
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="text-[10px] font-semibold text-text-3">Loại ảnh</span>
                            {IMAGE_CATEGORY_OPTIONS.map((option) => (
                              <VerityChip key={option.value} active={choice.imageCategory === option.value} onClick={() => updateChoice(asset.media_asset_id, { imageCategory: choice.imageCategory === option.value ? undefined : option.value })}>{option.label}</VerityChip>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <IntakeDecisionHistory decisions={intake.decisions || []} />

          <div className="mt-5 flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] leading-relaxed text-text-3">Duyệt sẽ khóa hồ sơ theo phiên bản hiện tại. Nếu contributor đã sửa trong lúc bạn xem, hệ thống sẽ yêu cầu tải lại.</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" disabled={submitting} onClick={() => void decide('rejected')} className="min-h-11 rounded-xl border border-border-strong px-3.5 text-[12px] font-bold text-text-2 transition-colors hover:border-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50">Từ chối</button>
              <button type="button" disabled={submitting} onClick={() => void decide('needs_changes')} className="min-h-11 rounded-xl border border-warn-border bg-warn-soft/50 px-3.5 text-[12px] font-bold text-warn transition-colors hover:bg-warn-soft disabled:opacity-50">Yêu cầu bổ sung</button>
              <button type="button" disabled={submitting} onClick={() => void decide('approved')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover disabled:cursor-wait disabled:opacity-60"><Send aria-hidden="true" className="h-4 w-4" />{submitting ? 'Đang lưu…' : 'Duyệt hồ sơ'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResolvedIntakeCard({ intake }: { intake: ProductIntake }) {
  const { showToast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const [startingSupplement, setStartingSupplement] = useState(false);
  const [referenceStatus, setReferenceStatus] = useState(intake.reference_status);
  const meta = referenceStatusCopy[referenceStatus];
  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intake.id}/retry-reference`, { method: 'POST' });
      setReferenceStatus('queued');
      showToast('Đã đưa ảnh mẫu vào hàng đợi xử lý lại.', 'success');
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể thử lại ảnh mẫu.', 'warn');
    } finally {
      setRetrying(false);
    }
  };
  const startSupplement = () => {
    if (startingSupplement || intake.status !== 'approved') return;
    setStartingSupplement(true);
    try {
      const sku = intake.final_sku || intake.proposed_sku;
      if (!sku) throw new Error('Hồ sơ chưa có SKU để bổ sung ảnh.');
      window.location.assign(`/upload?prefill_sku=${encodeURIComponent(sku)}`);
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể mở trang bổ sung ảnh.', 'warn');
      setStartingSupplement(false);
    }
  };
  const publishedCount = intake.assets.filter((asset) => asset.publish_status === 'published').length;
  const previewAssets = intake.assets.slice(0, 5);
  const overflowCount = intake.assets.length - previewAssets.length;
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="truncate text-[12px] font-bold text-text-1">{intakeTitle(intake)}</p><p className="mt-0.5 font-mono text-[10.5px] text-text-3">{intake.final_sku || intake.proposed_sku || 'Chưa có SKU'}</p></div>
        <VerityBadge size="sm" variant={meta.variant}>{meta.label}</VerityBadge>
      </div>
      {previewAssets.length > 0 ? (
        <div className="mt-2 flex items-center gap-1">
          {previewAssets.map((asset) => (
            <div key={asset.media_asset_id} className="h-9 w-9 flex-none overflow-hidden rounded-md border border-border bg-surface-2">
              {asset.thumbnail_url ? <img src={asset.thumbnail_url} alt={asset.title || 'Ảnh trong hồ sơ'} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-text-3"><ImageIcon aria-hidden="true" className="h-3 w-3" /></div>}
            </div>
          ))}
          {overflowCount > 0 ? <span className="text-[10.5px] font-semibold text-text-3">+{overflowCount}</span> : null}
        </div>
      ) : null}
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-text-3">
        {intake.assets.length} ảnh{publishedCount > 0 ? ` · ${publishedCount} đã xuất bản` : ''}
        {intake.owner?.name || intake.owner?.email ? ` · Gửi bởi ${intake.owner?.name || intake.owner?.email}` : ''}
        {fmtDate(intake.submitted_at) ? ` · ${fmtDate(intake.submitted_at)}` : ''}
      </p>
      {intake.reviewer?.name || intake.reviewer?.email ? (
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-text-3">Duyệt bởi {intake.reviewer?.name || intake.reviewer?.email}{fmtDate(intake.reviewed_at) ? ` · ${fmtDate(intake.reviewed_at)}` : ''}</p>
      ) : null}
      {referenceStatus === 'failed' ? <button type="button" onClick={() => void retry()} disabled={retrying} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-bad-border px-2.5 text-[11.5px] font-bold text-bad transition-colors hover:bg-bad-soft disabled:opacity-50"><RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />{retrying ? 'Đang thử lại…' : 'Thử lại ảnh mẫu'}</button> : null}
      {intake.status === 'approved' && intake.final_product_id ? <button type="button" onClick={() => void startSupplement()} disabled={startingSupplement} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[11.5px] font-bold text-text-2 transition-colors hover:bg-hover hover:text-text-1 disabled:opacity-50"><ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />{startingSupplement ? 'Đang mở…' : 'Bổ sung ảnh'}</button> : null}
    </div>
  );
}

function InfoRow({ label, value, mono = false, link = false }: { label: string; value?: string | null; mono?: boolean; link?: boolean }) {
  if (!value) return null;
  return <div><dt className="text-[10.5px] font-semibold uppercase tracking-wide text-text-3">{label}</dt>{link ? <dd className="mt-0.5 truncate text-verity"><a href={value} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">{value}</a></dd> : <dd className={`mt-0.5 break-words text-text-1 ${mono ? 'font-mono' : ''}`}>{value}</dd>}</div>;
}
