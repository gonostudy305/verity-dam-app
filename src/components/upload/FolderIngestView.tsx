'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2, FolderUp, Loader2, RotateCcw } from 'lucide-react';
import { apiRequest } from '@/lib/client/api';
import { MAX_UPLOAD_FILES, validateUploadCandidate } from '@/lib/media-api';
import { useToast } from '@/components/common/Toast';
import { cn } from '@/lib/utils';
import {
  chunkFiles,
  parseFolderEntries,
  type FolderFileInput,
  type FolderSkuGroup,
  type SkippedFile,
} from './folderIngest';
import { collectDroppedFiles, type PickedFile } from './folderDrop';
import { mapWithConcurrency, postFileToConvertWithRetry } from './uploadClient';
import { BatchIngestProgress } from './BatchIngestProgress';

type FolderFile = FolderFileInput & { file: File };
type Group = FolderSkuGroup<FolderFile>;

type SkuCheck =
  | { state: 'checking' }
  | { state: 'ok'; primarySku: string; name: string }
  | { state: 'unknown' }
  | { state: 'error'; message: string };

interface GroupRun {
  status: 'uploading' | 'done' | 'error';
  uploaded: number;
  queued: number;
  duplicates: number;
  error?: string;
}

interface Plan {
  groups: Group[];
  skipped: SkippedFile[];
  rejected: Array<{ relativePath: string; message: string }>;
}

interface FolderIngestViewProps {
  context: string;
  permission: 'public' | 'internal';
  /** Báo cho cha biết đang upload, để khóa việc chuyển tab. */
  onBusyChange?: (busy: boolean) => void;
}

const SKIP_LABEL: Record<SkippedFile['reason'], string> = {
  hidden: 'tệp/thư mục ẩn',
  not_image: 'không phải ảnh',
  no_sku_folder: 'không nằm trong thư mục SKU',
};

const keyOf = (group: Group) => group.sku.toLowerCase();

async function checkSku(sku: string): Promise<SkuCheck> {
  const result = await apiRequest<{
    exists: boolean;
    product: { primary_sku: string; display_name: string | null } | null;
  }>(`/api/catalog/check-sku?sku=${encodeURIComponent(sku)}`);
  if (!result.exists || !result.product) return { state: 'unknown' };
  return { state: 'ok', primarySku: result.product.primary_sku, name: result.product.display_name || '' };
}

export function FolderIngestView({ context, permission, onBusyChange }: FolderIngestViewProps) {
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [checks, setChecks] = useState<Record<string, SkuCheck>>({});
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [runs, setRuns] = useState<Record<string, GroupRun>>({});
  const [busy, setBusy] = useState(false);
  const batchIdRef = useRef<string>('');
  // Số lô (chunk) đã hoàn tất của mỗi nhóm, để thử lại không upload trùng.
  const completedChunksRef = useRef<Record<string, number>>({});

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  const runCheck = async (group: Group) => {
    const key = keyOf(group);
    setChecks((current) => ({ ...current, [key]: { state: 'checking' } }));
    try {
      const result = await checkSku(group.sku);
      setChecks((current) => ({ ...current, [key]: result }));
      // Chỉ SKU có trong danh mục mới được chọn sẵn; còn lại người dùng tự quyết.
      setInclude((current) => ({ ...current, [key]: result.state === 'ok' }));
    } catch (error) {
      setChecks((current) => ({
        ...current,
        [key]: { state: 'error', message: error instanceof Error ? error.message : 'Không kiểm tra được SKU.' },
      }));
    }
  };

  const loadFiles = (picked: PickedFile[]) => {
    if (busy) return;
    if (picked.length === 0) {
      showToast('Không tìm thấy tệp nào trong thư mục đã chọn.', 'warn');
      return;
    }
    const inputs: FolderFile[] = picked.map(({ file, relativePath }) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      relativePath,
      file,
    }));
    const parsed = parseFolderEntries(inputs);
    const rejected: Plan['rejected'] = [];
    const groups = parsed.groups
      .map((group) => ({
        ...group,
        files: group.files.filter((entry) => {
          try {
            validateUploadCandidate(entry.file);
            return true;
          } catch (error) {
            rejected.push({
              relativePath: entry.relativePath,
              message: error instanceof Error ? error.message : 'Tệp không hợp lệ.',
            });
            return false;
          }
        }),
      }))
      .filter((group) => group.files.length > 0);

    batchIdRef.current = crypto.randomUUID();
    completedChunksRef.current = {};
    setRuns({});
    setInclude({});
    setChecks(Object.fromEntries(groups.map((group) => [keyOf(group), { state: 'checking' } as SkuCheck])));
    setPlan({ groups, skipped: parsed.skipped, rejected });
    void mapWithConcurrency(groups, 4, (group) => runCheck(group));
  };

  const reset = () => {
    if (busy) return;
    setPlan(null);
    setChecks({});
    setInclude({});
    setRuns({});
  };

  const uploadGroup = async (group: Group) => {
    const key = keyOf(group);
    const check = checks[key];
    // prefill_sku phải là primary_sku do danh mục trả về: check-sku khớp cả alias,
    // còn /api/uploads/complete chỉ khớp primary_sku/code và sẽ rollback nếu sai.
    const prefillSku = check?.state === 'ok' ? check.primarySku : undefined;
    const chunks = chunkFiles(group.files, MAX_UPLOAD_FILES);
    const startAt = completedChunksRef.current[key] ?? 0;
    setRuns((current) => ({
      ...current,
      [key]: { status: 'uploading', uploaded: current[key]?.uploaded ?? 0, queued: current[key]?.queued ?? 0, duplicates: current[key]?.duplicates ?? 0 },
    }));

    try {
      for (let index = startAt; index < chunks.length; index += 1) {
        const uploaded = await mapWithConcurrency(chunks[index], 2, async (entry) => {
          const result = await postFileToConvertWithRetry(entry.file, () => undefined);
          setRuns((current) => ({ ...current, [key]: { ...current[key], uploaded: current[key].uploaded + 1 } }));
          return {
            storagePath: result.storagePath,
            fileName: result.fileName,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            sha256: result.sha256,
          };
        });
        const trimmed = context.trim();
        const completed = await apiRequest<{ data: Array<{ is_duplicate: boolean }> }>('/api/uploads/complete', {
          method: 'POST',
          body: JSON.stringify({
            files: uploaded,
            context: trimmed.length > 0 ? trimmed : null,
            permission,
            prefill_sku: prefillSku,
            batch_id: batchIdRef.current,
            source_type: 'FolderImport',
          }),
        });
        completedChunksRef.current[key] = index + 1;
        setRuns((current) => ({
          ...current,
          [key]: {
            ...current[key],
            queued: current[key].queued + completed.data.length,
            duplicates: current[key].duplicates + completed.data.filter((item) => item.is_duplicate).length,
          },
        }));
      }
      setRuns((current) => ({ ...current, [key]: { ...current[key], status: 'done' } }));
    } catch (error) {
      setRuns((current) => ({
        ...current,
        [key]: { ...current[key], status: 'error', error: error instanceof Error ? error.message : 'Không thể hoàn tất nhóm này.' },
      }));
    }
  };

  const startUpload = async (targets: Group[]) => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    try {
      await mapWithConcurrency(targets, 2, (group) => uploadGroup(group));
    } finally {
      setBusy(false);
    }
  };

  if (!plan) {
    return (
      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void collectDroppedFiles(event.dataTransfer)
            .then(loadFiles)
            .catch(() => showToast('Không đọc được thư mục vừa thả.', 'warn'));
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Chọn hoặc kéo thả thư mục ảnh"
        className="group flex h-[300px] cursor-pointer select-none flex-col items-center justify-center gap-3.5 rounded-2xl border-2 border-dashed border-border-strong bg-surface p-6 text-center shadow-xs transition-all hover:border-verity hover:bg-surface-2/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity focus-visible:ring-offset-2"
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="folder-input"
          {...({ webkitdirectory: '' } as Record<string, string>)}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            loadFiles(files.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })));
          }}
        />
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-verity-soft text-verity-fg shadow-xs transition-transform group-hover:scale-110">
          <FolderUp className="h-7 w-7" />
        </div>
        <div className="space-y-1">
          <h3 className="text-[17px] font-bold text-text-1">Kéo thả thư mục ảnh vào đây</h3>
          <p className="text-[13px] text-text-2">
            Mỗi thư mục con đặt tên theo mã SKU (vd <span className="font-mono">INL301/</span>). Bạn sẽ xem trước và xác nhận trước khi upload.
          </p>
        </div>
        <span className="mt-2 inline-flex min-h-11 items-center rounded-xl bg-verity px-5 text-[13px] font-bold text-white shadow-sm transition-all group-hover:bg-verity-hover">
          Chọn thư mục từ máy
        </span>
      </div>
    );
  }

  const { groups, skipped, rejected } = plan;
  const checking = groups.some((group) => checks[keyOf(group)]?.state === 'checking');
  const selected = groups.filter((group) => include[keyOf(group)]);
  const selectedFiles = selected.reduce((sum, group) => sum + group.files.length, 0);
  const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);
  const unknownCount = groups.filter((group) => {
    const state = checks[keyOf(group)]?.state;
    return state === 'unknown' || state === 'error';
  }).length;
  const started = Object.keys(runs).length > 0;
  const allDone = started && selected.length > 0 && selected.every((group) => runs[keyOf(group)]?.status === 'done');
  const failed = selected.filter((group) => runs[keyOf(group)]?.status === 'error');

  return (
    <div className="space-y-4 animate-pop">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="space-y-0.5">
          <h3 className="text-[15px] font-bold text-text-1">
            {groups.length} nhóm SKU · {totalFiles} ảnh
          </h3>
          <p className="text-[12px] text-text-2">
            {checking ? 'Đang đối chiếu SKU với danh mục…' : `${groups.length - unknownCount} SKU có trong danh mục`}
            {unknownCount > 0 ? ` · ${unknownCount} SKU không xác định` : ''}
            {skipped.length + rejected.length > 0 ? ` · ${skipped.length + rejected.length} tệp bị loại` : ''}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {allDone ? (
            <Link href="/review" className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-verity px-5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-verity-hover">
              <span>Mở hàng duyệt</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : null}
          {failed.length > 0 && !busy ? (
            <button
              type="button"
              onClick={() => void startUpload(failed)}
              className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-verity px-4 text-[13px] font-bold text-white shadow-sm hover:bg-verity-hover"
            >
              <RotateCcw className="h-4 w-4" />
              <span>Thử lại {failed.length} nhóm lỗi</span>
            </button>
          ) : null}
          {!started ? (
            <button
              type="button"
              onClick={() => void startUpload(selected)}
              disabled={busy || checking || selected.length === 0}
              className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-verity px-5 text-[13px] font-bold text-white shadow-sm transition-all hover:bg-verity-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Xác nhận & Upload {selectedFiles} ảnh</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-surface px-3.5 text-[13px] font-semibold text-text-2 shadow-xs hover:bg-surface-2 hover:text-text-1 disabled:opacity-50"
          >
            <RotateCcw className="h-4 w-4" />
            <span>{started ? 'Nhập thư mục khác' : 'Chọn lại'}</span>
          </button>
        </div>
      </div>

      {started ? (
        <div className="space-y-2">
          <BatchIngestProgress batchId={batchIdRef.current} expectedTotal={selectedFiles} uploading={busy} />
          <p className="px-1 text-[12px] text-text-2">
            Ảnh không có SKU từ thư mục sẽ nằm trong hàng duyệt để người duyệt gắn nhãn.
          </p>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-2xs">
        <table className="w-full min-w-[640px] text-left text-[12.5px]">
          <thead className="border-b border-border bg-surface-2/60 text-text-3">
            <tr>
              <th className="w-10 px-3 py-2" aria-label="Chọn" />
              <th className="px-3 py-2 font-semibold">Thư mục / SKU</th>
              <th className="px-3 py-2 font-semibold">Sản phẩm trong danh mục</th>
              <th className="px-3 py-2 text-right font-semibold">Ảnh</th>
              <th className="px-3 py-2 font-semibold">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => {
              const key = keyOf(group);
              const check = checks[key] ?? { state: 'checking' as const };
              const run = runs[key];
              const hasDupNames = group.duplicateNames.length > 0;
              return (
                <tr key={key} className="border-b border-border last:border-0">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Nhập nhóm ${group.sku}`}
                      checked={Boolean(include[key])}
                      disabled={busy || started || check.state === 'checking'}
                      onChange={(event) => setInclude((current) => ({ ...current, [key]: event.target.checked }))}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono font-bold text-text-1">{group.sku}</span>
                    {group.tier ? <span className="ml-2 text-[11px] text-text-3">{group.tier}</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    {check.state === 'checking' ? (
                      <span className="inline-flex items-center gap-1 text-text-3"><Loader2 className="h-3.5 w-3.5 animate-spin" />Đang kiểm tra…</span>
                    ) : check.state === 'ok' ? (
                      <span className="text-text-1">
                        {check.name || check.primarySku}
                        {check.primarySku.toLowerCase() !== group.sku.toLowerCase() ? (
                          <span className="ml-1 font-mono text-[11px] text-text-3">→ {check.primarySku}</span>
                        ) : null}
                      </span>
                    ) : check.state === 'unknown' ? (
                      <span className="inline-flex items-center gap-1 text-warn">
                        <AlertTriangle className="h-3.5 w-3.5" />Không có trong danh mục
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-bad">
                        {check.message}
                        <button type="button" onClick={() => void runCheck(group)} className="font-semibold underline">Kiểm tra lại</button>
                      </span>
                    )}
                    {(check.state === 'unknown' || check.state === 'error') && include[key] ? (
                      <div className="text-[11px] text-text-3">Sẽ nhập KHÔNG gắn SKU, chờ người duyệt xác minh.</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{group.files.length}</td>
                  <td className="px-3 py-2">
                    {run?.status === 'uploading' ? (
                      <span className="inline-flex items-center gap-1 text-text-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{run.uploaded}/{group.files.length}</span>
                    ) : run?.status === 'done' ? (
                      <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 className="h-3.5 w-3.5" />Đã vào hàng đợi</span>
                    ) : run?.status === 'error' ? (
                      <span className="text-bad">{run.error}</span>
                    ) : hasDupNames ? (
                      <span className={cn('text-warn')}>Trùng tên: {group.duplicateNames.slice(0, 3).join(', ')}</span>
                    ) : include[key] ? (
                      <span className="text-text-3">Sẵn sàng</span>
                    ) : (
                      <span className="text-text-3">Bỏ qua</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {skipped.length + rejected.length > 0 ? (
        <details className="rounded-xl border border-border bg-surface px-4 py-3 text-[12px] text-text-2">
          <summary className="cursor-pointer font-semibold">{skipped.length + rejected.length} tệp bị loại khỏi lô</summary>
          <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto font-mono text-[11px]">
            {skipped.slice(0, 100).map((item) => (
              <li key={`s-${item.relativePath}`}>{item.relativePath} — {SKIP_LABEL[item.reason]}</li>
            ))}
            {rejected.slice(0, 100).map((item) => (
              <li key={`r-${item.relativePath}`}>{item.relativePath} — {item.message}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
