'use client';

import React, { useEffect, useRef, useState } from 'react';
import { UploadDropzone } from './UploadDropzone';
import { BatchContextSelector } from './BatchContextSelector';
import { StagedFileGrid, StagedFile } from './StagedFileGrid';
import { PipelineCardList } from './PipelineCardList';
import { UploadItem } from '@/types/media';
import { apiRequest } from '@/lib/client/api';
import { MAX_UPLOAD_FILES, validateUploadCandidate } from '@/lib/media-api';
import { useToast } from '@/components/common/Toast';
import { useUploadSession } from './useUploadSession';
import { mapWithConcurrency, postFileToConvertWithRetry } from './uploadClient';
import { FolderIngestView } from './FolderIngestView';
import { ArrowRight, Image as ImageIcon, RotateCcw, Send, X } from 'lucide-react';
import Link from 'next/link';
import { statusToItemPatch, UPLOAD_POLL_TIMEOUT_MESSAGE, type UploadProcessingStatus } from '@/lib/upload-status';

let stagedIdCounter = 0;
function nextStagedId() {
  stagedIdCounter += 1;
  return `staged-${Date.now()}-${stagedIdCounter}`;
}

export function UploadView() {
  const { showToast } = useToast();
  const session = useUploadSession();
  const [context, setContext] = useState('');
  const [permission, setPermission] = useState<'public' | 'internal'>('public');
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [prefillSku, setPrefillSku] = useState<string>('');
  const [mode, setMode] = useState<'files' | 'folder'>('files');
  const [folderBusy, setFolderBusy] = useState(false);
  const previewUrls = useRef<string[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const skuParam = new URLSearchParams(window.location.search).get('prefill_sku');
    if (skuParam?.trim()) {
      setPrefillSku(skuParam.trim());
      showToast(`Đang ở chế độ bổ sung ảnh cho SKU: ${skuParam.trim()}`, 'info');
      const url = new URL(window.location.href);
      url.searchParams.delete('prefill_sku');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  const releasePreviews = () => {
    previewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.current = [];
  };

  useEffect(() => {
    // On mount: check if there are pending worker jobs from a previous navigation.
    const stale = session.load();
    if (stale.length > 0) {
      const restoredItems: UploadItem[] = stale.map((entry) => ({
        id: entry.taskId,
        file: { name: entry.fileName, size: 0, type: '' },
        previewUrl: '',
        stage: 3,
        progress: 100,
        assetId: entry.assetId,
        processing_state: 'queued',
      }));
      setUploadItems(restoredItems);
      void monitorWorkerJobsRef.current(stale.map((e) => ({ assetId: e.assetId, taskId: e.taskId })));
    }
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const currentItems = session.load();
      if (currentItems.length > 0) {
        void monitorWorkerJobsRef.current(currentItems.map((e) => ({ assetId: e.assetId, taskId: e.taskId })));
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      releasePreviews();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateItem = (id: string, patch: Partial<UploadItem>) => {
    setUploadItems((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const monitorWorkerJobs = async (assetTasks: Array<{ assetId: string; taskId: string }>) => {
    const pending = new Set(assetTasks.map((item) => item.assetId));
    const missingCount: Record<string, number> = {};
    const maxAttempts = Math.max(120, assetTasks.length * 40);
    let attemptsSinceLastProgress = 0;
    const maxStallAttempts = 60; // 60 attempts * 2s = 120s without progress
    // Last explanation seen per asset, so a timed-out card can still say why it waits.
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

        response.data.forEach((status) => {
          const item = assetTasks.find((candidate) => candidate.assetId === status.media_asset_id);
          if (!item) return;
          const patch = statusToItemPatch(status);
          lastIssue[status.media_asset_id] = patch.job_issue;
          updateItem(item.taskId, patch);
          if (status.ingest_status === 'ready' || status.ingest_status === 'failed') {
            pending.delete(status.media_asset_id);
            session.remove(status.media_asset_id);
            attemptsSinceLastProgress = 0;
          }
        });

        // Prune phantom asset IDs that are not found in the database.
        for (const assetId of Array.from(pending)) {
          if (!returnedIds.has(assetId)) {
            missingCount[assetId] = (missingCount[assetId] || 0) + 1;
            if (missingCount[assetId] >= 4) {
              const item = assetTasks.find((candidate) => candidate.assetId === assetId);
              if (item) {
                updateItem(item.taskId, {
                  processing_state: 'unknown',
                });
              }
              pending.delete(assetId);
              session.remove(assetId);
            }
          }
        }
      } catch {
        // The upload itself is durable. Keep polling rather than replacing a
        // recoverable status-network error with a false processing failure.
      }
    }

    // Auto-refresh gave up (no progress for ~2 minutes, or the attempt budget ran
    // out) while some assets are still unfinished. Say so on the card instead of
    // leaving it looking like it is still being processed; "Kiểm tra lại" resumes.
    // The assets stay in the upload session so they are re-monitored on return.
    pending.forEach((assetId) => {
      const item = assetTasks.find((candidate) => candidate.assetId === assetId);
      if (!item) return;
      updateItem(item.taskId, {
        processing_state: 'unknown',
        job_issue: lastIssue[assetId] ?? UPLOAD_POLL_TIMEOUT_MESSAGE,
      });
    });
  };

  // Stable ref so the on-mount effect can call monitorWorkerJobs before it is defined in scope.
  const monitorWorkerJobsRef = useRef(monitorWorkerJobs);
  monitorWorkerJobsRef.current = monitorWorkerJobs;

  const [recheckingIds, setRecheckingIds] = useState<Set<string>>(new Set());

  // Manual recovery action for 'unknown'/'blocked' items -- a single, on-demand
  // status query, distinct from the automatic monitorWorkerJobs polling loop.
  const recheckStatus = async (taskId: string, assetId: string) => {
    if (recheckingIds.has(taskId)) return;
    setRecheckingIds((current) => new Set(current).add(taskId));
    try {
      const params = new URLSearchParams();
      params.append('id', assetId);
      const response = await apiRequest<{ data: UploadProcessingStatus[] }>(`/api/uploads/status?${params}`);
      const status = response.data.find((entry) => entry.media_asset_id === assetId);
      if (!status) {
        showToast('Vẫn chưa tìm thấy trạng thái xử lý cho ảnh này trong hệ thống.', 'warn');
        return;
      }
      updateItem(taskId, statusToItemPatch(status));
      if (status.ingest_status === 'ready' || status.ingest_status === 'failed') {
        session.remove(assetId);
      } else if (status.ingest_status === 'processing' || status.ingest_status === 'queued') {
        // Found again and still in flight -- resume background polling for it.
        void monitorWorkerJobs([{ assetId, taskId }]);
      }
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : 'Không thể kiểm tra lại trạng thái.', 'warn');
    } finally {
      setRecheckingIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
    }
  };

  // Files land here first — nothing is uploaded yet. The batch sits "pending"
  // so the uploader can review it, add/remove files, and write (or skip) a
  // description before anything touches R2/the database.
  const stageFiles = (files: File[]) => {
    if (isProcessing || files.length === 0) return;
    const total = stagedFiles.length + files.length;
    if (total > MAX_UPLOAD_FILES) {
      showToast(
        `Một lô chỉ được tối đa ${MAX_UPLOAD_FILES} tệp (đang có ${stagedFiles.length}, thêm ${files.length} sẽ vượt quá).`,
        'warn'
      );
      return;
    }
    try {
      files.forEach((file) => validateUploadCandidate(file));
    } catch (validationError) {
      showToast(validationError instanceof Error ? validationError.message : 'Tệp không hợp lệ.', 'warn');
      return;
    }

    const additions: StagedFile[] = files.map((file) => {
      const previewUrl = URL.createObjectURL(file);
      previewUrls.current.push(previewUrl);
      return { id: nextStagedId(), file, previewUrl };
    });
    setStagedFiles((prev) => [...prev, ...additions]);
  };

  const removeStagedFile = (id: string) => {
    setStagedFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrls.current = previewUrls.current.filter((url) => url !== target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const clearStagedBatch = () => {
    stagedFiles.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    previewUrls.current = previewUrls.current.filter(
      (url) => !stagedFiles.some((item) => item.previewUrl === url)
    );
    setStagedFiles([]);
  };

  const handleSubmitBatch = async () => {
    if (isProcessing || stagedFiles.length === 0) return;

    const batch = stagedFiles;
    const files = batch.map((item) => item.file);
    // Empty/whitespace-only text must reach the API as `null`, the same as
    // "no context set" always has -- never as an empty string, or it would
    // get stored on origin_info.batch_context and shown to the AI as a
    // (meaningless) hint instead of being omitted entirely.
    const trimmedContext = context.trim();
    const submittedContext = trimmedContext.length > 0 ? trimmedContext : null;

    const tasks: UploadItem[] = batch.map((item) => ({
      id: item.id,
      file: item.file,
      previewUrl: item.previewUrl,
      stage: 0,
      progress: 0,
    }));
    setUploadItems(tasks);
    setStagedFiles([]);
    setIsProcessing(true);

    try {
      const completeFiles = await mapWithConcurrency(tasks, 4, async (task) => {
        const file = task.file as File;
        updateItem(task.id, { progress: 1 });
        try {
          const uploaded = await postFileToConvertWithRetry(file, (progress) => updateItem(task.id, { progress }));
          updateItem(task.id, { stage: 2, progress: 100 });
          return {
            storagePath: uploaded.storagePath,
            fileName: uploaded.fileName,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            sha256: uploaded.sha256,
          };
        } catch (uploadError) {
          updateItem(task.id, {
            error: uploadError instanceof Error ? uploadError.message : 'Không thể upload tệp.',
            progress: 100,
          });
          throw uploadError;
        }
      });

      const completed = await apiRequest<{ data: Array<{ media_asset_id: string; review_queue_id: string; is_duplicate: boolean }> }>('/api/uploads/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: completeFiles,
          context: submittedContext,
          permission,
          prefill_sku: prefillSku || undefined,
        }),
      });

      completed.data.forEach((item, index) => {
        updateItem(tasks[index].id, {
          stage: 3,
          progress: 100,
          assetId: item.media_asset_id,
          processing_state: 'queued',
          is_duplicate: item.is_duplicate,
          duplicate_pct: item.is_duplicate ? 100 : undefined,
        });
      });

      // Persist session so polling can resume if the user navigates away.
      const assetTasks = completed.data.map((item, index) => ({
        assetId: item.media_asset_id,
        taskId: tasks[index].id,
      }));
      session.save(assetTasks.map((t, i) => ({
        taskId: t.taskId,
        assetId: t.assetId,
        fileName: files[i]?.name ?? '',
        completedAt: new Date().toISOString(),
      })));
      void monitorWorkerJobs(assetTasks);
      showToast(
        prefillSku
          ? `Đã tải ảnh lên cho SKU ${prefillSku}! Ảnh đã chuyển vào Hàng chờ duyệt nhẹ.`
          : 'Đã tải lên thành công! AI đang tự động nhận diện và chuyển ảnh vào Hàng chờ duyệt.',
        'success'
      );
    } catch (uploadError) {
      showToast(uploadError instanceof Error ? uploadError.message : 'Không thể hoàn tất lô upload.', 'warn');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleKeepDupe = (id: string) => {
    updateItem(id, { held: true, is_duplicate: false });
    showToast('Ảnh sẽ được giữ để duyệt riêng trong hàng chờ.', 'info');
  };

  const handleDropDupe = (id: string) => {
    updateItem(id, { dropped: true, is_duplicate: false });
    showToast('Ảnh trùng được đánh dấu để xử lý trong hàng chờ duyệt.', 'info');
  };

  const resetUpload = () => {
    releasePreviews();
    session.clear();
    setUploadItems([]);
    setContext('');
    setIsProcessing(false);
    if (prefillSku) setPrefillSku('');
  };

  // A batch is "settled" once every item has reached a terminal ingest state --
  // 'ready' is not the only one; 'failed'/'blocked'/'unknown' are terminal too
  // and must not be silently folded into "sẵn sàng duyệt".
  const TERMINAL_STATES = new Set(['ready', 'failed', 'blocked', 'unknown']);
  const isSettled = uploadItems.length > 0 && uploadItems.every((item) => TERMINAL_STATES.has(item.processing_state || ''));
  const readyCount = uploadItems.filter((item) => item.processing_state === 'ready').length;
  const stalledCount = uploadItems.filter((item) => item.processing_state === 'blocked' || item.processing_state === 'unknown').length;
  const failedCount = uploadItems.filter((item) => item.processing_state === 'failed').length;
  const trimmedContext = context.trim();

  const totalStagedSize = stagedFiles.reduce((acc, f) => acc + f.file.size, 0);
  const formattedStagedSize =
    totalStagedSize < 1024 * 1024
      ? `${Math.max(1, Math.round(totalStagedSize / 1024))} KB`
      : `${(totalStagedSize / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="mx-auto max-w-[1360px] space-y-4 p-3 sm:space-y-6 sm:p-6">
      {prefillSku ? (
        <div className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-2.5 shadow-2xs">
          <div className="flex items-center gap-2 text-[12.5px]">
            <ImageIcon className="h-4 w-4 text-verity" />
            <span>
              Đang ở chế độ bổ sung ảnh cho sản phẩm SKU:{' '}
              <strong className="font-mono font-bold text-text-1">{prefillSku}</strong>
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setPrefillSku('');
              showToast('Đã thoát chế độ bổ sung SKU.', 'info');
            }}
            className="text-[12px] font-semibold text-text-3 hover:text-text-1 hover:underline cursor-pointer"
          >
            Hủy chế độ bổ sung
          </button>
        </div>
      ) : null}
      {uploadItems.length > 0 ? (
        <div className="space-y-5 animate-pop">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <div className="space-y-0.5">
              <h3 className="text-[15px] font-bold text-text-1">
                {!isSettled
                  ? `Hệ thống AI đang phân tích ${uploadItems.length} tệp…`
                  : readyCount === uploadItems.length
                    ? `${uploadItems.length} tệp sẵn sàng duyệt`
                    : `${readyCount}/${uploadItems.length} tệp sẵn sàng duyệt`}
              </h3>
              <p className="text-[12px] text-text-2">
                {trimmedContext ? `· Ngữ cảnh: ${trimmedContext}` : '· Không đặt ngữ cảnh lô'}
                {isSettled && stalledCount > 0 ? ` · ${stalledCount} cần kiểm tra lại trạng thái` : ''}
                {isSettled && failedCount > 0 ? ` · ${failedCount} lỗi` : ''}
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {readyCount > 0 ? (
                <Link href="/review" className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-verity px-5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-verity-hover">
                  <span>Mở hàng duyệt</span>
                  <ArrowRight className="w-4 h-4" />
                </Link>
              ) : null}
              <button
                type="button"
                onClick={resetUpload}
                className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-[13px] font-semibold text-text-2 shadow-xs transition-all hover:bg-surface-2 hover:text-text-1"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Thêm lô mới</span>
              </button>
            </div>
          </div>
          <PipelineCardList
            items={uploadItems}
            onKeepDupe={handleKeepDupe}
            onDropDupe={handleDropDupe}
            onRecheckStatus={(taskId, assetId) => void recheckStatus(taskId, assetId)}
            recheckingIds={recheckingIds}
          />
        </div>
      ) : stagedFiles.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start animate-pop">
          {/* Left Column: Staged Images (7 cols) */}
          <div className="lg:col-span-7 xl:col-span-7 space-y-3.5">
            {/* Batch Info Header */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold text-text-1">
                  {stagedFiles.length} tệp trong lô
                </span>
                <span className="text-[12px] font-mono text-text-3 bg-surface-2 px-2 py-0.5 rounded-md border border-border">
                  {formattedStagedSize}
                </span>
              </div>
              <button
                type="button"
                onClick={clearStagedBatch}
                className="flex items-center gap-1 text-[12px] font-semibold text-text-3 hover:text-bad transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                <span>Hủy cả lô</span>
              </button>
            </div>

            {/* Scrollable Thumbnails Grid */}
            <div className="overflow-visible rounded-2xl border border-border bg-surface-2/40 p-2 shadow-2xs sm:p-3 lg:max-h-[540px] lg:overflow-y-auto lg:pr-1">
              <StagedFileGrid files={stagedFiles} onRemove={removeStagedFile} />
            </div>

            {/* Compact Dropzone to add more */}
            <UploadDropzone
              onFilesSelected={stageFiles}
              compact
              title="Kéo thêm ảnh hoặc dán trực tiếp (Ctrl+V)"
              subtitle="Tự động gộp thêm vào lô đang chọn"
            />
          </div>

          {/* Right Column: Batch Context & Action (5 cols, sticky) */}
          <div className="lg:col-span-5 xl:col-span-5 space-y-4 lg:sticky lg:top-4">
            <BatchContextSelector
              context={context}
              onChange={setContext}
              permission={permission}
              onPermissionChange={setPermission}
            />

            {/* Submit Action Box */}
            <div className="p-4 rounded-2xl border border-border bg-surface shadow-xs space-y-2.5">
              <button
                type="button"
                onClick={() => void handleSubmitBatch()}
                disabled={isProcessing}
                className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-verity px-6 text-[14px] font-bold text-white shadow-sm transition-all hover:bg-verity-hover hover:shadow-md active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send className="w-4 h-4" />
                <span>
                  {isProcessing ? 'Đang chuẩn bị upload...' : `Xác nhận & Upload ${stagedFiles.length} tệp`}
                </span>
              </button>
              <p className="text-[11.5px] text-center text-text-3 leading-relaxed">
                AI Vision sẽ tự động nhận diện sản phẩm, phân loại hình ảnh và tìm mã SKU tương ứng.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {prefillSku ? null : (
            <div role="tablist" aria-label="Cách nhập ảnh" className="inline-flex rounded-xl border border-border bg-surface p-1 shadow-2xs">
              {([['files', 'Tải tệp'], ['folder', 'Nhập thư mục']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={mode === value}
                  disabled={folderBusy && mode !== value}
                  onClick={() => setMode(value)}
                  className={`min-h-9 rounded-lg px-4 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    mode === value ? 'bg-verity text-white shadow-sm' : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {mode === 'folder' && !prefillSku ? (
            <FolderIngestView context={context} permission={permission} onBusyChange={setFolderBusy} />
          ) : (
            <UploadDropzone onFilesSelected={stageFiles} />
          )}
          <BatchContextSelector
            context={context}
            onChange={setContext}
            permission={permission}
            onPermissionChange={setPermission}
          />
        </div>
      )}
    </div>
  );
}
