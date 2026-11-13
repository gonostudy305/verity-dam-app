'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Check, Globe, Image as ImageIcon, Loader2, RefreshCw, Send, Sparkles, X, ZoomIn,
} from 'lucide-react';
import { VerityBadge, type BadgeVariant } from '@/components/common/VerityBadge';
import { VerityChip } from '@/components/common/VerityChip';
import { useToast } from '@/components/common/Toast';
import { apiRequest } from '@/lib/client/api';
import { MAX_UPLOAD_FILES, validateUploadCandidate } from '@/lib/media-api';
import { statusToItemPatch, UPLOAD_POLL_TIMEOUT_MESSAGE, type UploadProcessingStatus } from '@/lib/upload-status';
import { UploadDropzone } from '@/components/upload/UploadDropzone';
import { StagedFileGrid, type StagedFile } from '@/components/upload/StagedFileGrid';
import { PipelineCardList } from '@/components/upload/PipelineCardList';
import { useUploadSession } from '@/components/upload/useUploadSession';
import { WebImagePicker, type FetchedWebImage } from '@/components/upload/WebImagePicker';
import { ProductIntakeForm, type ProductIntakeDraftFields } from './ProductIntakeForm';
import { ProductIntakeAssetModal } from './ProductIntakeAssetModal';
import type {
  CatalogProductSearchResult,
  ProductIntake,
  ProductIntakeAsset,
  ProductIntakeAssetDecision,
  ProductIntakeReferenceStatus,
  UploadItem,
} from '@/types/media';

type ReferenceRole = 'HERO' | 'ANGLE';
type ImageCategory = 'REAL' | 'STUDIO' | 'DESIGN';
type AssetChoice = {
  decision: Exclude<ProductIntakeAssetDecision, 'pending'>;
  isReference: boolean;
  role?: ReferenceRole;
  imageCategory?: ImageCategory;
};
type WorkspaceStagedFile = StagedFile & { webSource?: FetchedWebImage };

const ROLE_OPTIONS: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'HERO', label: 'Ảnh chính' },
  { value: 'ANGLE', label: 'Ảnh góc' },
];
const IMAGE_CATEGORY_OPTIONS: Array<{ value: ImageCategory; label: string }> = [
  { value: 'REAL', label: 'Ảnh thực tế' },
  { value: 'STUDIO', label: 'Ảnh Studio' },
  { value: 'DESIGN', label: 'Ảnh Thiết kế' },
];

// Khớp EDITABLE_STATUSES ở product-intakes.ts -- tránh gọi PATCH/asset-meta
// vô ích khi backend chắc chắn từ chối (submitted/approved/rejected).
const EDITABLE_STATUSES = new Set(['draft', 'needs_changes']);

const referenceStatusCopy: Record<ProductIntakeReferenceStatus, { label: string; variant: BadgeVariant }> = {
  none: { label: 'Chưa có ảnh mẫu', variant: 'mute' },
  queued: { label: 'Đang chuẩn bị', variant: 'ai' },
  ready: { label: 'Sẵn sàng nhận diện', variant: 'ok' },
  failed: { label: 'Cần thử lại', variant: 'bad' },
};
const STATUS_COPY: Record<ProductIntake['status'], string> = {
  draft: 'Đang làm',
  submitted: 'Chờ duyệt',
  needs_changes: 'Cần bổ sung',
  approved: 'Đã đóng',
  rejected: 'Đã từ chối',
};
const DECISION_ACTION_LABEL: Record<string, string> = {
  created: 'Tạo hồ sơ',
  submitted: 'Gửi duyệt',
  needs_changes: 'Yêu cầu bổ sung',
  approved: 'Duyệt & đóng hồ sơ',
  rejected: 'Từ chối hồ sơ',
  reference_retry: 'Thử lại ảnh mẫu',
};

const EMPTY_DRAFT: ProductIntakeDraftFields = {
  proposedName: '',
  proposedBrand: '',
  proposedModel: '',
  proposedSku: '',
  proposedCategory: '',
  proposedSpace: '',
  sourceUrl: '',
  notes: '',
};

function asRole(value?: string | null): ReferenceRole | undefined {
  return value === 'HERO' || value === 'ANGLE' ? value : undefined;
}
function asImageCategory(value?: string | null): ImageCategory | undefined {
  return value === 'REAL' || value === 'STUDIO' || value === 'DESIGN' ? value : undefined;
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function fmtDate(value?: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** Mệnh đề đầu của caption AI -- đủ để gợi ý suffix cho title, không cần gọi lại vision. */
function firstClause(caption?: string | null): string {
  if (!caption) return '';
  return caption.split(/[.,;\n]/)[0]?.trim() || '';
}
function initialChoice(asset: ProductIntakeAsset): AssetChoice {
  return {
    decision: asset.decision === 'rejected' ? 'rejected' : 'approved',
    isReference: Boolean(asset.is_reference || asset.proposed_reference)
      && asset.ingest_status === 'ready'
      && ['photo', 'render', 'screenshot'].includes(String(asset.media_type)),
    role: asRole(asset.confirmed_role) || asRole(asset.proposed_role),
    imageCategory: asImageCategory(asset.confirmed_image_category) || asImageCategory(asset.proposed_image_category),
  };
}
function intakeLabel(intake: ProductIntake): string {
  return intake.proposed_name || intake.final_sku || intake.proposed_sku || 'Hồ sơ chưa đặt tên';
}
function draftFromIntake(intake: ProductIntake): ProductIntakeDraftFields {
  return {
    proposedName: intake.proposed_name || '',
    proposedBrand: intake.proposed_brand || '',
    proposedModel: intake.proposed_model || '',
    proposedSku: intake.proposed_sku || '',
    proposedCategory: intake.proposed_category || '',
    proposedSpace: intake.proposed_space || '',
    sourceUrl: intake.source_url || '',
    notes: intake.notes || '',
  };
}
function draftPayload(draft: ProductIntakeDraftFields) {
  const optional = (value: string) => value.trim() || undefined;
  return {
    proposed_name: optional(draft.proposedName),
    proposed_brand: optional(draft.proposedBrand),
    proposed_model: optional(draft.proposedModel),
    proposed_sku: optional(draft.proposedSku),
    proposed_category: optional(draft.proposedCategory),
    proposed_space: optional(draft.proposedSpace),
    source_url: optional(draft.sourceUrl),
    notes: optional(draft.notes),
  };
}
function canSaveDraft(draft: ProductIntakeDraftFields): boolean {
  return draft.proposedName.trim().length >= 3 && draft.proposedBrand.trim().length > 0 && draft.proposedSku.trim().length >= 3;
}

interface ConvertedUploadResponse {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  originalFileName: string;
  converted: boolean;
}

function postFileToConvert(file: File, onProgress: (progress: number) => void): Promise<ConvertedUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/uploads/convert');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new Error('Không thể kết nối đến máy chủ upload.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try { resolve(JSON.parse(request.responseText) as ConvertedUploadResponse); }
        catch { reject(new Error('Phản hồi từ máy chủ không hợp lệ.')); }
      } else {
        try {
          const err = JSON.parse(request.responseText);
          reject(new Error(err?.error?.message || err?.message || 'Tải lên thất bại.'));
        } catch { reject(new Error(`Tải lên thất bại với mã lỗi ${request.status}.`)); }
      }
    };
    const formData = new FormData();
    formData.append('file', file);
    request.send(formData);
  });
}
async function postFileToConvertWithRetry(file: File, onProgress: (progress: number) => void): Promise<ConvertedUploadResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await postFileToConvert(file, onProgress); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Không thể upload tệp sau nhiều lần thử.');
}
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
let stagedIdCounter = 0;
function nextStagedId() {
  stagedIdCounter += 1;
  return `pi-staged-${Date.now()}-${stagedIdCounter}`;
}

/** Workspace 1 trang: khai báo -> upload/AI -> review từng ảnh -> duyệt & đóng
 * hồ sơ, thay cho luồng cũ save-draft -> submit -> sang /review duyệt lại. */
export function ProductIntakeWorkspace({ intakeId }: { intakeId: string }) {
  const { showToast } = useToast();
  const session = useUploadSession();
  const previewUrls = useRef<string[]>([]);

  const [intake, setIntake] = useState<ProductIntake | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<ProductIntakeDraftFields>(EMPTY_DRAFT);
  const draftReadyRef = useRef(false);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const [autosaving, setAutosaving] = useState(false);

  const [stagedFiles, setStagedFiles] = useState<WorkspaceStagedFile[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [recheckingIds, setRecheckingIds] = useState<Set<string>>(new Set());
  const [webPickerOpen, setWebPickerOpen] = useState(false);

  const [choices, setChoices] = useState<Record<string, AssetChoice>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(new Set());
  const [finalSku, setFinalSku] = useState('');
  const [reviewerNote, setReviewerNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingApproveWithoutReference, setPendingApproveWithoutReference] = useState(false);
  const [activeAssetIndex, setActiveAssetIndex] = useState<number | null>(null);

  const applyIntake = (next: ProductIntake) => {
    setIntake(next);
    draftReadyRef.current = false;
    setDraft(draftFromIntake(next));
    queueMicrotask(() => { draftReadyRef.current = true; });
    setChoices((current) => {
      const merged = { ...current };
      next.assets.forEach((asset) => {
        if (!merged[asset.media_asset_id]) merged[asset.media_asset_id] = initialChoice(asset);
      });
      return merged;
    });
    setTitles((current) => {
      const merged = { ...current };
      next.assets.forEach((asset) => {
        if (!merged[asset.media_asset_id] || merged[asset.media_asset_id].trim() === '') {
          merged[asset.media_asset_id] = asset.title || '';
        }
      });
      return merged;
    });
    setUploadItems((current) => {
      if (current.length === 0) return current;
      let changed = false;
      const updated = current.map((item) => {
        if (!item.assetId) return item;
        const matchingAsset = next.assets.find((a) => a.media_asset_id === item.assetId);
        if (matchingAsset && (matchingAsset.ingest_status === 'ready' || matchingAsset.ingest_status === 'failed')) {
          if (item.processing_state !== matchingAsset.ingest_status) {
            changed = true;
            return {
              ...item,
              stage: 3,
              progress: 100,
              processing_state: matchingAsset.ingest_status as UploadItem['processing_state'],
              error: matchingAsset.ingest_status === 'failed' ? matchingAsset.ingest_error || 'Không thể xử lý tệp ảnh này.' : undefined,
            };
          }
        }
        return item;
      });
      return changed ? updated : current;
    });
    setFinalSku((current) => current || next.final_sku || next.proposed_sku || '');
    setReviewerNote((current) => current || next.reviewer_note || '');
  };

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const response = await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intakeId}`);
      applyIntake(response.data);
    } catch (error) {
      if (!silent) setLoadError(error instanceof Error ? error.message : 'Không thể tải hồ sơ.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { previewUrls.current.forEach((url) => URL.revokeObjectURL(url)); previewUrls.current = []; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intakeId]);

  useEffect(() => () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); }, []);

  const locked = !intake || !EDITABLE_STATUSES.has(intake.status);

  const persistDraft = async (nextDraft: ProductIntakeDraftFields) => {
    if (!intake || !canSaveDraft(nextDraft)) return;
    setAutosaving(true);
    try {
      const response = await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intake.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...draftPayload(nextDraft), expected_revision: intake.revision }),
      });
      applyIntake(response.data);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể tự động lưu hồ sơ.', 'warn');
    } finally {
      setAutosaving(false);
    }
  };

  const handleDraftChange = (next: ProductIntakeDraftFields) => {
    setDraft(next);
    if (!draftReadyRef.current || locked) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => { void persistDraft(next); }, 900);
  };

  const stageFiles = (files: File[]) => {
    if (isUploading || files.length === 0) return;
    const total = stagedFiles.length + files.length;
    if (total > MAX_UPLOAD_FILES) {
      showToast(`Một lô chỉ được tối đa ${MAX_UPLOAD_FILES} tệp (đang có ${stagedFiles.length}, thêm ${files.length} sẽ vượt quá).`, 'warn');
      return;
    }
    try { files.forEach((file) => validateUploadCandidate(file)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Tệp không hợp lệ.', 'warn'); return; }
    const additions: WorkspaceStagedFile[] = files.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.push(previewUrl);
      return { id: nextStagedId(), file, previewUrl };
    });
    setStagedFiles((prev) => [...prev, ...additions]);
  };

  const stageWebImages = (images: FetchedWebImage[]) => {
    if (images.length === 0) return;
    const room = MAX_UPLOAD_FILES - stagedFiles.length;
    const accepted = images.slice(0, Math.max(0, room));
    if (accepted.length < images.length) showToast(`Một lô chỉ được tối đa ${MAX_UPLOAD_FILES} tệp; đã bỏ qua ${images.length - accepted.length} ảnh.`, 'warn');
    if (accepted.length === 0) return;
    setStagedFiles((prev) => [...prev, ...accepted.map((image) => ({
      id: nextStagedId(),
      file: { name: image.fileName, size: image.sizeBytes, type: image.mimeType },
      previewUrl: image.source_url,
      webSource: image,
    }))]);
    showToast(`Đã thêm ${accepted.length} ảnh từ link vào lô.`, 'success');
  };

  const removeStagedFile = (id: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) { URL.revokeObjectURL(target.previewUrl); previewUrls.current = previewUrls.current.filter((url) => url !== target.previewUrl); }
      return prev.filter((item) => item.id !== id);
    });
  };

  const updateUploadItem = (id: string, patch: Partial<UploadItem>) => {
    setUploadItems((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const monitorWorkerJobs = async (assetTasks: Array<{ assetId: string; taskId: string }>) => {
    const pending = new Set(assetTasks.map((item) => item.assetId));
    const missingCount: Record<string, number> = {};
    const maxAttempts = Math.max(120, assetTasks.length * 40);
    let attemptsSinceLastProgress = 0;
    const maxStallAttempts = 60; // 60 attempts * 2s = 120s without any asset completing
    const lastIssue: Record<string, string | undefined> = {};

    for (let attempt = 0; attempt < maxAttempts && pending.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      attemptsSinceLastProgress += 1;

      if (attemptsSinceLastProgress > maxStallAttempts) {
        break;
      }

      try {
        const params = new URLSearchParams();
        pending.forEach((assetId) => params.append('id', assetId));
        const response = await apiRequest<{ data: UploadProcessingStatus[] }>(`/api/uploads/status?${params}`);
        const returnedIds = new Set(response.data.map((s) => s.media_asset_id));
        let anyFinished = false;

        response.data.forEach((status) => {
          const item = assetTasks.find((candidate) => candidate.assetId === status.media_asset_id);
          if (!item) return;
          const patch = statusToItemPatch(status);
          lastIssue[status.media_asset_id] = patch.job_issue;
          updateUploadItem(item.taskId, patch);
          if (status.ingest_status === 'ready' || status.ingest_status === 'failed') {
            pending.delete(status.media_asset_id);
            session.remove(status.media_asset_id);
            anyFinished = true;
            attemptsSinceLastProgress = 0;
          }
        });

        if (anyFinished) {
          void load(true);
        }

        for (const assetId of Array.from(pending)) {
          if (!returnedIds.has(assetId)) {
            missingCount[assetId] = (missingCount[assetId] || 0) + 1;
            if (missingCount[assetId] >= 4) {
              const item = assetTasks.find((candidate) => candidate.assetId === assetId);
              if (item) updateUploadItem(item.taskId, { processing_state: 'unknown' });
              pending.delete(assetId);
              session.remove(assetId);
            }
          }
        }
      } catch { /* upload đã durable; giữ nguyên trạng thái và tiếp tục poll */ }
    }
    // Auto-refresh gave up with assets still unfinished: say so on the card
    // ("Kiểm tra lại" resumes) instead of leaving it looking in progress.
    pending.forEach((assetId) => {
      const item = assetTasks.find((candidate) => candidate.assetId === assetId);
      if (!item) return;
      updateUploadItem(item.taskId, {
        processing_state: 'unknown',
        job_issue: lastIssue[assetId] ?? UPLOAD_POLL_TIMEOUT_MESSAGE,
      });
    });
    void load(true);
  };

  const recheckStatus = async (taskId: string, assetId: string) => {
    if (recheckingIds.has(taskId)) return;
    setRecheckingIds((current) => new Set(current).add(taskId));
    try {
      const params = new URLSearchParams();
      params.append('id', assetId);
      const response = await apiRequest<{ data: UploadProcessingStatus[] }>(`/api/uploads/status?${params}`);
      const status = response.data.find((entry) => entry.media_asset_id === assetId);
      if (!status) { showToast('Vẫn chưa tìm thấy trạng thái xử lý cho ảnh này.', 'warn'); return; }
      updateUploadItem(taskId, statusToItemPatch(status));
      if (status.ingest_status === 'ready' || status.ingest_status === 'failed') { session.remove(assetId); void load(true); }
      else if (status.ingest_status === 'processing' || status.ingest_status === 'queued') void monitorWorkerJobs([{ assetId, taskId }]);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể kiểm tra lại trạng thái.', 'warn');
    } finally {
      setRecheckingIds((current) => { const next = new Set(current); next.delete(taskId); return next; });
    }
  };

  const handleUploadBatch = async () => {
    if (!intake || isUploading || stagedFiles.length === 0) return;
    const batch = stagedFiles;
    const tasks: UploadItem[] = batch.map((item) => ({ id: item.id, file: item.file, previewUrl: item.previewUrl, stage: 0, progress: 0 }));
    setUploadItems((current) => [...current, ...tasks]);
    setStagedFiles([]);
    setIsUploading(true);
    try {
      const completeFiles = await mapWithConcurrency(tasks, 4, async (task, index) => {
        const staged = batch[index];
        updateUploadItem(task.id, { progress: 1 });
        if (staged.webSource) {
          const web = staged.webSource;
          updateUploadItem(task.id, { stage: 2, progress: 100 });
          return { storagePath: web.storagePath, fileName: web.fileName, mimeType: web.mimeType, sizeBytes: web.sizeBytes, source_url: web.source_url, sha256: web.sha256 };
        }
        try {
          const uploaded = await postFileToConvertWithRetry(staged.file as File, (progress) => updateUploadItem(task.id, { progress }));
          updateUploadItem(task.id, { stage: 2, progress: 100 });
          return { storagePath: uploaded.storagePath, fileName: uploaded.fileName, mimeType: uploaded.mimeType, sizeBytes: uploaded.sizeBytes, sha256: uploaded.sha256 };
        } catch (uploadError) {
          updateUploadItem(task.id, { error: uploadError instanceof Error ? uploadError.message : 'Không thể upload tệp.', progress: 100 });
          throw uploadError;
        }
      });

      const completed = await apiRequest<{ data: Array<{ media_asset_id: string; is_duplicate: boolean }> }>('/api/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: completeFiles, intake_id: intake.id }),
      });

      completed.data.forEach((item, index) => {
        updateUploadItem(tasks[index].id, { stage: 3, progress: 100, assetId: item.media_asset_id, processing_state: 'queued', is_duplicate: item.is_duplicate, duplicate_pct: item.is_duplicate ? 100 : undefined });
      });

      const assetTasks = completed.data.map((item, index) => ({ assetId: item.media_asset_id, taskId: tasks[index].id }));
      session.save(assetTasks.map((t, i) => ({ taskId: t.taskId, assetId: t.assetId, fileName: batch[i]?.file.name ?? '', completedAt: new Date().toISOString() })));
      void monitorWorkerJobs(assetTasks);
      await load();
      showToast('Đã gắn ảnh vào hồ sơ. AI đang phân tích, kết quả sẽ hiện ngay dưới.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể hoàn tất lô upload.', 'warn');
    } finally {
      setIsUploading(false);
    }
  };

  const handleKeepDupe = (id: string) => { updateUploadItem(id, { held: true, is_duplicate: false }); showToast('Đã giữ ảnh dù trùng lặp.', 'info'); };
  const handleDropDupe = (id: string) => { updateUploadItem(id, { dropped: true, is_duplicate: false }); showToast('Đã đánh dấu bỏ ảnh trùng.', 'info'); };

  const updateChoice = (assetId: string, patch: Partial<AssetChoice>) => {
    setChoices((current) => {
      const next = { ...current[assetId], ...patch } as AssetChoice;
      if (next.decision === 'rejected') next.isReference = false;
      return { ...current, [assetId]: next };
    });
  };

  const toggleBatchSelect = (assetId: string) => {
    setSelectedForBatch((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  };

  const applyBatchDecision = (decision: 'approved' | 'rejected') => {
    if (selectedForBatch.size === 0) return;
    setChoices((current) => {
      const next = { ...current };
      selectedForBatch.forEach((assetId) => {
        const existing = next[assetId] || { decision: 'approved' as const, isReference: false };
        next[assetId] = { ...existing, decision, isReference: decision === 'rejected' ? false : existing.isReference };
      });
      return next;
    });
    setSelectedForBatch(new Set());
  };

  const saveAssetTitle = async (assetId: string, title: string) => {
    if (!intake) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      await apiRequest(`/api/product-intakes/${intake.id}/assets/${assetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu tiêu đề ảnh.', 'warn');
    }
  };

  const applyAiSuggestion = (asset: ProductIntakeAsset) => {
    const clause = firstClause(asset.suggested_caption);
    if (!clause) { showToast('Ảnh này chưa có gợi ý AI.', 'info'); return; }
    const label = intake ? intakeLabel(intake) : '';
    const composed = label && label !== 'Hồ sơ chưa đặt tên' ? `${label} — ${clause}` : clause;
    setTitles((current) => ({ ...current, [asset.media_asset_id]: composed }));
    void saveAssetTitle(asset.media_asset_id, composed);
  };

  const keptCount = useMemo(() => Object.values(choices).filter((c) => c.decision === 'approved').length, [choices]);
  const referenceCount = useMemo(() => Object.values(choices).filter((c) => c.decision === 'approved' && c.isReference).length, [choices]);
  const analyzedCount = intake ? intake.assets.filter((a) => a.ingest_status === 'ready' || a.ingest_status === 'failed').length : 0;
  const pendingAnalysis = intake ? intake.assets.length - analyzedCount : 0;

  // Tự động đồng bộ trạng thái khi còn ảnh đang chờ phân tích
  useEffect(() => {
    if (pendingAnalysis <= 0) return;
    let pollCount = 0;
    const maxPolls = 100; // 100 * 3s = 300s (5 phút)
    const interval = setInterval(() => {
      pollCount += 1;
      if (pollCount > maxPolls) {
        clearInterval(interval);
        return;
      }
      void load(true);
    }, 3_000);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void load(true);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [pendingAnalysis, intakeId]);

  const runDecision = async (decision: 'approved' | 'needs_changes' | 'rejected', opts: { skipReferenceCheck?: boolean } = {}) => {
    if (!intake || submitting) return;
    if (decision === 'approved') {
      if (!finalSku.trim()) { showToast('Cần có SKU trước khi duyệt hồ sơ.', 'warn'); return; }
      if (intake.assets.length === 0) { showToast('Cần ít nhất một ảnh trước khi duyệt hồ sơ.', 'warn'); return; }
      if (keptCount === 0) { showToast('Cần giữ ít nhất một ảnh để duyệt hồ sơ.', 'warn'); return; }
      if (referenceCount === 0 && !opts.skipReferenceCheck) { setPendingApproveWithoutReference(true); return; }
    }
    setPendingApproveWithoutReference(false);
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
      applyIntake(response.data);
      if (decision === 'approved') showToast(referenceCount > 0 ? 'Đã duyệt & đóng hồ sơ. Ảnh mẫu đang được chuẩn bị.' : 'Đã duyệt & đóng hồ sơ. Sản phẩm chưa có ảnh mẫu.', 'success');
      else if (decision === 'needs_changes') showToast('Đã đánh dấu hồ sơ cần bổ sung.', 'info');
      else showToast('Đã từ chối hồ sơ.', 'warn');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể lưu quyết định.', 'warn');
    } finally {
      setSubmitting(false);
    }
  };

  const submitForReview = async () => {
    if (!intake || submitting) return;
    setSubmitting(true);
    try {
      const response = await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intake.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_revision: intake.revision }),
      });
      applyIntake(response.data);
      showToast('Đã gửi hồ sơ để reviewer duyệt.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể gửi hồ sơ.', 'warn');
    } finally {
      setSubmitting(false);
    }
  };

  const retryReference = async () => {
    if (!intake) return;
    try {
      const response = await apiRequest<{ data: ProductIntake }>(`/api/product-intakes/${intake.id}/retry-reference`, { method: 'POST' });
      applyIntake(response.data);
      showToast('Đã đưa ảnh mẫu vào hàng đợi xử lý lại.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể thử lại ảnh mẫu.', 'warn');
    }
  };

  const renderAssetCard = (asset: ProductIntakeAsset, index: number) => {
    const choice = choices[asset.media_asset_id] || { decision: 'approved' as const, isReference: false };
    const title = titles[asset.media_asset_id] ?? (asset.title || '');
    const referenceAssetType = ['photo', 'render', 'screenshot'].includes(String(asset.media_type));
    const referenceEligible = !locked && choice.decision === 'approved' && asset.ingest_status === 'ready' && referenceAssetType;
    const selected = selectedForBatch.has(asset.media_asset_id);
    return (
      <article key={asset.media_asset_id} className="overflow-hidden rounded-xl border border-border bg-surface-2/35">
        <div className="flex h-[92px] bg-surface-2">
          {!locked ? (
            <label className="flex w-8 flex-none items-center justify-center border-r border-border/60 bg-surface-2">
              <input type="checkbox" checked={selected} onChange={() => toggleBatchSelect(asset.media_asset_id)} className="h-4 w-4 rounded border-border text-verity focus:ring-verity" aria-label="Chọn ảnh này để xử lý hàng loạt" />
            </label>
          ) : null}
          {asset.thumbnail_url ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setActiveAssetIndex(index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveAssetIndex(index);
                }
              }}
              className="group/thumb relative h-full w-[104px] flex-none overflow-hidden cursor-pointer bg-surface-2 select-none"
              title="Click để phóng to ảnh & ra quyết định"
            >
              <img
                src={asset.thumbnail_url}
                alt={asset.title || 'Ảnh trong hồ sơ'}
                className="h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
              />
              <div className="absolute inset-0 bg-black/25 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                <div className="rounded-full bg-black/60 p-1 text-white shadow-xs">
                  <ZoomIn className="w-3.5 h-3.5" />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid w-[104px] flex-none place-items-center text-text-3">
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1 p-2.5">
            <p className="text-[10.5px] text-text-3">{asset.ingest_error ? 'Lỗi xử lý' : asset.ingest_status || 'Đã tải lên'}</p>
            {asset.source_url ? (
              <p className="mt-1 flex items-center gap-1 text-[10.5px] text-warn">
                <Globe aria-hidden="true" className="h-3 w-3 flex-none" />
                <a href={asset.source_url} target="_blank" rel="noopener noreferrer nofollow" title={asset.source_url} className="min-w-0 truncate underline decoration-dotted hover:text-text-1">{hostOf(asset.source_url)}</a>
              </p>
            ) : null}
            {asset.sku_match?.sku ? <p className="mt-1 truncate text-[10.5px] text-ai" title={`AI gợi ý: ${asset.sku_match.sku}`}>AI gợi ý SKU: {asset.sku_match.sku}{asset.sku_match.requires_reviewer_confirmation ? ' · cần xác minh' : ''}</p> : null}
          </div>
        </div>
        <div className="space-y-2 p-2.5">
          {asset.ingest_error ? <p className="rounded-md border border-bad-border bg-bad-soft/50 px-2 py-1.5 text-[10.5px] leading-snug text-bad">{asset.ingest_error}</p> : null}
          <div className="flex items-center gap-1.5">
            <input
              value={title}
              onChange={(event) => setTitles((current) => ({ ...current, [asset.media_asset_id]: event.target.value }))}
              onBlur={(event) => void saveAssetTitle(asset.media_asset_id, event.target.value)}
              disabled={locked}
              placeholder="Tiêu đề ảnh"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-[11.5px] text-text-1 outline-none focus:border-verity focus:ring-2 focus:ring-verity/20 disabled:cursor-not-allowed disabled:bg-surface-2"
            />
            {!locked && asset.suggested_caption ? (
              <button type="button" onClick={() => applyAiSuggestion(asset)} title={asset.suggested_caption} className="grid h-9 w-9 flex-none place-items-center rounded-lg border border-ai-border bg-ai-soft/50 text-ai transition-colors hover:bg-ai-soft">
                <Sparkles aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={`Quyết định ảnh ${asset.title || asset.media_asset_id}`}>
            <button type="button" disabled={locked} onClick={() => updateChoice(asset.media_asset_id, { decision: 'approved' })} className={`min-h-11 rounded-lg border px-2 text-[11.5px] font-bold transition-colors disabled:cursor-not-allowed ${choice.decision === 'approved' ? 'border-ok bg-ok-soft text-ok' : 'border-border bg-surface text-text-2 hover:bg-hover'}`}><Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />Giữ</button>
            <button type="button" disabled={locked} onClick={() => updateChoice(asset.media_asset_id, { decision: 'rejected' })} className={`min-h-11 rounded-lg border px-2 text-[11.5px] font-bold transition-colors disabled:cursor-not-allowed ${choice.decision === 'rejected' ? 'border-bad bg-bad-soft text-bad' : 'border-border bg-surface text-text-2 hover:bg-hover'}`}><X aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />Loại</button>
          </div>
          <label className={`flex min-h-11 items-center gap-2 rounded-lg px-2 text-[11.5px] font-semibold ${referenceEligible ? 'cursor-pointer bg-ai-soft/55 text-ai' : 'cursor-not-allowed bg-surface-2 text-text-disabled'}`}>
            <input type="checkbox" checked={choice.isReference} disabled={!referenceEligible} onChange={(event) => updateChoice(asset.media_asset_id, { isReference: event.target.checked })} className="h-4 w-4 rounded border-border text-verity focus:ring-verity" />
            {!referenceAssetType ? 'Video không dùng làm ảnh mẫu' : asset.ingest_status === 'ready' ? 'Dùng làm ảnh mẫu' : 'Chờ xử lý xong để làm mẫu'}
          </label>
          {referenceEligible && choice.isReference ? (
            <div className="space-y-1.5 rounded-lg bg-surface-2/60 p-2">
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
  };

  if (loading) {
    return <div className="grid h-full min-h-[50vh] place-items-center text-[13px] text-text-3"><span className="inline-flex items-center gap-2"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Đang tải hồ sơ…</span></div>;
  }

  if (loadError || !intake) {
    return (
      <div className="grid h-full min-h-[50vh] place-items-center p-6">
        <div className="max-w-md rounded-2xl border border-warn-border bg-warn-soft/70 p-5 text-center shadow-xs">
          <p className="text-[13px] leading-relaxed text-warn">{loadError || 'Không tìm thấy hồ sơ.'}</p>
          <button type="button" onClick={() => void load()} className="mt-4 min-h-11 rounded-xl border border-warn-border px-4 text-[12.5px] font-bold text-warn transition-colors hover:bg-warn-soft">Thử lại</button>
        </div>
      </div>
    );
  }

  const referenceMeta = referenceStatusCopy[intake.reference_status];
  const isClosed = intake.status === 'approved' || intake.status === 'rejected';

  return (
    <div className="bg-paper p-3 sm:p-6">
      <div className="mx-auto max-w-[1000px] space-y-4 pb-24">
        <Link href="/product-intakes" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-[12.5px] font-bold text-text-2 transition-colors hover:bg-hover hover:text-text-1">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />Hồ sơ sản phẩm
        </Link>

        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[16px] font-bold text-text-1">{intakeLabel(intake)}</h1>
              <VerityBadge variant="verity" size="sm">{STATUS_COPY[intake.status]}</VerityBadge>
              <VerityBadge variant={referenceMeta.variant} size="sm" dot>{referenceMeta.label}</VerityBadge>
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-text-2">{[intake.proposed_brand, intake.proposed_model, intake.final_sku || intake.proposed_sku].filter(Boolean).join(' · ') || 'Chưa có SKU'} · {intake.assets.length} ảnh</p>
          </div>
          {intake.reference_status === 'failed' ? (
            <button type="button" onClick={() => void retryReference()} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-bad-border px-3 text-[12px] font-bold text-bad transition-colors hover:bg-bad-soft"><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />Thử lại ảnh mẫu</button>
          ) : null}
        </div>

        {intake.reference_error ? <p className="rounded-xl border border-bad-border bg-bad-soft/60 px-3 py-2 text-[11.5px] leading-relaxed text-bad">{intake.reference_error}</p> : null}

        <ProductIntakeForm
          value={draft}
          onChange={handleDraftChange}
          onSaveDraft={() => void persistDraft(draft)}
          saving={autosaving}
          locked={locked}
          intakeId={intake.id}
          onFetchImagesFromUrl={() => setWebPickerOpen(true)}
          autosave
        />
        <WebImagePicker open={webPickerOpen} onOpenChange={setWebPickerOpen} initialUrl={draft.sourceUrl} onImported={stageWebImages} />

        {!locked ? (
          <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
            <h2 className="text-[13px] font-bold text-text-1">Ảnh & AI</h2>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-text-2">Tải ảnh lên, hệ thống tự động phân tích AI ngay sau khi tải xong.</p>
            <div className="mt-3">
              <UploadDropzone onFilesSelected={stageFiles} compact={stagedFiles.length > 0} />
            </div>
            {stagedFiles.length > 0 ? (
              <div className="mt-3 space-y-3">
                <StagedFileGrid files={stagedFiles} onRemove={removeStagedFile} />
                <button type="button" onClick={() => void handleUploadBatch()} disabled={isUploading} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover disabled:cursor-wait disabled:opacity-60">
                  {isUploading ? 'Đang tải lên…' : `Tải ${stagedFiles.length} ảnh & chạy AI`}
                </button>
              </div>
            ) : null}
            {uploadItems.length > 0 ? (
              <div className="mt-4">
                <PipelineCardList items={uploadItems} onKeepDupe={handleKeepDupe} onDropDupe={handleDropDupe} onRecheckStatus={recheckStatus} recheckingIds={recheckingIds} />
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[13px] font-bold text-text-1">Review từng ảnh</h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-3">
                <span>Đã giữ: {keptCount}/{intake.assets.length} · Ảnh mẫu: {referenceCount}</span>
                {pendingAnalysis > 0 ? (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 font-medium text-ai">
                      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                      Đang phân tích {pendingAnalysis} ảnh
                    </span>
                    <button
                      type="button"
                      onClick={() => void load(true)}
                      title="Làm mới trạng thái phân tích ảnh"
                      className="rounded border border-border/80 bg-surface-2/60 px-1.5 py-0.5 text-[10px] font-bold text-text-2 hover:bg-hover hover:text-text-1"
                    >
                      Làm mới
                    </button>
                  </>
                ) : null}
              </div>
            </div>
            {!locked && selectedForBatch.size > 0 ? (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-semibold text-text-3">{selectedForBatch.size} ảnh đã chọn</span>
                <button type="button" onClick={() => applyBatchDecision('approved')} className="min-h-11 rounded-lg border border-ok bg-ok-soft px-2.5 text-[11.5px] font-bold text-ok transition-colors hover:bg-ok-soft/70">Giữ đã chọn</button>
                <button type="button" onClick={() => applyBatchDecision('rejected')} className="min-h-11 rounded-lg border border-bad bg-bad-soft px-2.5 text-[11.5px] font-bold text-bad transition-colors hover:bg-bad-soft/70">Loại đã chọn</button>
              </div>
            ) : null}
          </div>

          {intake.assets.length === 0 ? (
            <div className="mt-4 grid min-h-[140px] place-items-center rounded-xl border border-dashed border-border-strong p-6 text-center text-[12.5px] text-text-3">Chưa có ảnh nào. Tải ảnh ở mục phía trên.</div>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {intake.assets.map((asset, index) => renderAssetCard(asset, index))}
            </div>
          )}
        </section>

        {intake.decisions && intake.decisions.length > 0 ? (
          <details className="rounded-xl border border-border/70 bg-surface-2/30 p-3">
            <summary className="cursor-pointer select-none text-[11.5px] font-bold text-text-2 hover:text-text-1">Lịch sử xử lý ({intake.decisions.length})</summary>
            <ol className="mt-2 space-y-1.5 border-t border-border/60 pt-2">
              {intake.decisions.map((entry, index) => (
                <li key={index} className="text-[11px] leading-relaxed text-text-2">
                  <span className="font-semibold text-text-1">{DECISION_ACTION_LABEL[entry.action] || entry.action}</span>
                  {entry.actor?.name || entry.actor?.email ? ` · ${entry.actor?.name || entry.actor?.email}` : ''}
                  {fmtDate(entry.created_at) ? ` · ${fmtDate(entry.created_at)}` : ''}
                  {entry.note ? <span className="block text-text-3">"{entry.note}"</span> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {!locked ? (
          <section className="sticky bottom-3 rounded-2xl border border-verity-border bg-surface p-4 shadow-md sm:p-5">
            {pendingApproveWithoutReference ? (
              <div className="mb-3 rounded-xl border border-warn-border bg-warn-soft/70 p-3 text-[12px] leading-relaxed text-warn">
                <p className="font-semibold">Sản phẩm sẽ chưa thể nhận diện bằng ảnh (chưa có ảnh mẫu).</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setPendingApproveWithoutReference(false)} className="min-h-11 rounded-lg border border-border px-3 text-[11.5px] font-bold text-text-2 transition-colors hover:bg-hover">Quay lại chọn ảnh</button>
                  <button type="button" onClick={() => void runDecision('approved', { skipReferenceCheck: true })} className="min-h-11 rounded-lg border border-warn-border bg-warn-soft px-3 text-[11.5px] font-bold text-warn transition-colors hover:bg-warn-soft/70">Đóng mà chưa có ảnh mẫu</button>
                </div>
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-[11.5px] font-semibold text-text-2">SKU chốt khi duyệt <span className="text-bad">*</span></span>
                  <input value={finalSku} onChange={(event) => setFinalSku(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-surface px-3 font-mono text-[12.5px] text-text-1 outline-none transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20" placeholder="VD: H1-EU" />
                </label>
                <label className="space-y-1.5">
                  <span className="text-[11.5px] font-semibold text-text-2">Ghi chú (tuỳ chọn)</span>
                  <input value={reviewerNote} onChange={(event) => setReviewerNote(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-surface px-3 text-[12.5px] text-text-1 outline-none transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20" placeholder="Hiển thị trong lịch sử xử lý" />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {intake.can_review ? (
                  <>
                    <button type="button" disabled={submitting} onClick={() => void runDecision('rejected')} className="min-h-11 rounded-xl border border-border-strong px-3.5 text-[12px] font-bold text-text-2 transition-colors hover:border-bad hover:bg-bad-soft hover:text-bad disabled:opacity-50">Từ chối</button>
                    <button type="button" disabled={submitting} onClick={() => void runDecision('needs_changes')} className="min-h-11 rounded-xl border border-warn-border bg-warn-soft/50 px-3.5 text-[12px] font-bold text-warn transition-colors hover:bg-warn-soft disabled:opacity-50">Yêu cầu bổ sung</button>
                    <button type="button" disabled={submitting} onClick={() => void runDecision('approved')} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover disabled:cursor-wait disabled:opacity-60"><Send aria-hidden="true" className="h-4 w-4" />{submitting ? 'Đang lưu…' : 'Duyệt & đóng hồ sơ'}</button>
                  </>
                ) : (
                  <button type="button" disabled={submitting || intake.status === 'submitted'} onClick={() => void submitForReview()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover disabled:cursor-wait disabled:opacity-60"><Send aria-hidden="true" className="h-4 w-4" />{intake.status === 'submitted' ? 'Đang chờ duyệt' : submitting ? 'Đang gửi…' : 'Gửi hồ sơ duyệt'}</button>
                )}
              </div>
            </div>
          </section>
        ) : isClosed ? (
          <div className="rounded-2xl border border-ok-border bg-ok-soft/40 p-4 text-[12.5px] leading-relaxed text-ok">
            {intake.status === 'approved' ? 'Hồ sơ đã được duyệt và đóng. Ảnh đã có trong Library.' : 'Hồ sơ đã bị từ chối.'}
            {intake.reviewer?.name || intake.reviewer?.email ? ` Xử lý bởi ${intake.reviewer?.name || intake.reviewer?.email}${fmtDate(intake.reviewed_at) ? ` · ${fmtDate(intake.reviewed_at)}` : ''}.` : ''}
          </div>
        ) : (
          <div className="rounded-2xl border border-ai-border bg-ai-soft/40 p-4 text-[12.5px] leading-relaxed text-ai">Hồ sơ đang chờ reviewer khác duyệt.</div>
        )}

        {intake && (
          <ProductIntakeAssetModal
            isOpen={activeAssetIndex !== null}
            onClose={() => setActiveAssetIndex(null)}
            assets={intake.assets}
            currentIndex={activeAssetIndex ?? 0}
            onNavigate={(idx) => setActiveAssetIndex(idx)}
            choices={choices}
            onUpdateChoice={updateChoice}
            titles={titles}
            onSaveTitle={saveAssetTitle}
            onApplyAiSuggestion={applyAiSuggestion}
            locked={locked}
          />
        )}
      </div>
    </div>
  );
}
