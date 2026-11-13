'use client';

import React, { useState } from 'react';
import { AlertTriangle, Check, Download, Link2, Search } from 'lucide-react';

import { apiRequest } from '@/lib/client/api';
import { ResponsiveDialogSheet } from '@/components/common/interaction-primitives';
import { cn } from '@/lib/utils';

export interface FetchedWebImage {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  sha256: string;
  source_url: string;
}

interface ImageCandidate {
  url: string;
  source: string;
}

interface WebImagePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill từ ô "Nguồn tham khảo" của hồ sơ. */
  initialUrl?: string;
  onImported: (images: FetchedWebImage[]) => void;
}

/** Trùng MIN_IMAGE_DIMENSION ở /api/uploads/from-url/fetch — dưới mức này server từ chối. */
const HARD_MIN_DIMENSION = 300;
/** Trên ngưỡng cứng nhưng vẫn nhỏ cho reference embedding: cảnh báo, không chặn. */
const WARN_DIMENSION = 500;
/** Trùng MAX_URLS_PER_REQUEST ở route fetch. */
const MAX_SELECTION = 12;

const inputClassName =
  'h-11 w-full rounded-xl border border-border bg-surface px-3 text-[12.5px] text-text-1 outline-none placeholder:text-text-3 transition-colors focus:border-verity focus:ring-2 focus:ring-verity/20';

type Measurement = { width: number; height: number } | 'failed';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Dán link trang sản phẩm -> chọn ảnh -> tải về R2.
 *
 * Lưới xem trước trỏ thẳng `<img src>` tới URL gốc nên trình duyệt tự tải và tự
 * đo kích thước: server không tốn băng thông cho ảnh người dùng không chọn.
 */
export function WebImagePicker({ open, onOpenChange, initialUrl, onImported }: WebImagePickerProps) {
  const [pageUrl, setPageUrl] = useState(initialUrl || '');
  const [manualUrl, setManualUrl] = useState('');
  const [candidates, setCandidates] = useState<ImageCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [measurements, setMeasurements] = useState<Record<string, Measurement>>({});
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const reset = () => {
    setCandidates([]);
    setSelected([]);
    setMeasurements({});
    setError(null);
    setNotice(null);
    setSearched(false);
  };

  const measure = (url: string, value: Measurement) => {
    setMeasurements((prev) => (prev[url] ? prev : { ...prev, [url]: value }));
  };

  const tooSmall = (url: string) => {
    const size = measurements[url];
    return size && size !== 'failed' && (size.width < HARD_MIN_DIMENSION || size.height < HARD_MIN_DIMENSION);
  };

  const addCandidates = (incoming: ImageCandidate[]) => {
    setCandidates((prev) => {
      const seen = new Set(prev.map((entry) => entry.url));
      return [...prev, ...incoming.filter((entry) => !seen.has(entry.url))];
    });
  };

  const handleExtract = async () => {
    if (!pageUrl.trim() || extracting) return;
    setExtracting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{ data: { page_url: string; candidates: ImageCandidate[] } }>(
        '/api/uploads/from-url/extract',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ page_url: pageUrl.trim() }),
        }
      );
      setSearched(true);
      setCandidates(response.data.candidates);
      setSelected([]);
      setMeasurements({});
      if (response.data.candidates.length === 0) {
        setNotice('Không tìm thấy ảnh nào trong trang. Trang có thể dựng ảnh bằng JavaScript — hãy dán thẳng link ảnh ở dưới.');
      }
    } catch (requestError) {
      setSearched(true);
      setError(errorMessage(requestError, 'Không đọc được trang nguồn.'));
    } finally {
      setExtracting(false);
    }
  };

  const handleAddManual = () => {
    const url = manualUrl.trim();
    if (!url) return;
    addCandidates([{ url, source: 'direct' }]);
    setSelected((prev) => (prev.includes(url) || prev.length >= MAX_SELECTION ? prev : [...prev, url]));
    setManualUrl('');
    setSearched(true);
  };

  const toggle = (url: string) => {
    setSelected((prev) => {
      if (prev.includes(url)) return prev.filter((entry) => entry !== url);
      if (prev.length >= MAX_SELECTION) return prev;
      return [...prev, url];
    });
  };

  const handleImport = async () => {
    if (!selected.length || importing) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{ data: { files: FetchedWebImage[]; errors: Array<{ url: string; message: string }> } }>(
        '/api/uploads/from-url/fetch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_urls: selected }),
        }
      );
      onImported(response.data.files);
      if (response.data.errors.length > 0) {
        setNotice(`${response.data.errors.length} ảnh không tải được: ${response.data.errors[0].message}`);
        setSelected((prev) => prev.filter((url) => response.data.errors.some((entry) => entry.url === url)));
        return;
      }
      onOpenChange(false);
      reset();
    } catch (requestError) {
      setError(errorMessage(requestError, 'Không tải được ảnh đã chọn.'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <ResponsiveDialogSheet
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      variant="dialog"
      title="Lấy ảnh từ link sản phẩm"
      description="Dán link trang sản phẩm của hãng hoặc đối thủ. Bạn chọn ảnh nào thì hệ thống mới tải ảnh đó về."
      className="md:w-[min(calc(100vw-2rem),56rem)] w-[min(calc(100vw-2rem),56rem)]"
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={pageUrl}
            onChange={(event) => setPageUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleExtract();
            }}
            type="url"
            inputMode="url"
            placeholder="https://… trang sản phẩm"
            className={inputClassName}
          />
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={extracting || !pageUrl.trim()}
            className="inline-flex min-h-11 flex-none items-center justify-center gap-2 rounded-xl bg-verity px-4 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Search aria-hidden="true" className="h-4 w-4" />
            {extracting ? 'Đang đọc…' : 'Tìm ảnh'}
          </button>
        </div>

        {error ? (
          <p className="flex items-start gap-2 rounded-xl border border-bad-border bg-bad-soft/50 p-3 text-[12px] leading-relaxed text-bad">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 flex-none" />
            <span>{error}</span>
          </p>
        ) : null}
        {notice ? (
          <p className="rounded-xl border border-warn-border bg-warn-soft/50 p-3 text-[12px] leading-relaxed text-warn">{notice}</p>
        ) : null}

        {candidates.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <span className="text-[12px] font-semibold text-text-2">
                {candidates.length} ảnh tìm thấy · đã chọn {selected.length}/{MAX_SELECTION}
              </span>
              <span className="text-[11px] text-text-3">Ảnh dưới {WARN_DIMENSION}px thường là ảnh social bị cắt.</span>
            </div>
            <div className="grid max-h-[46vh] grid-cols-2 gap-2.5 overflow-y-auto rounded-xl border border-border bg-surface-2/40 p-2 sm:grid-cols-3 md:grid-cols-4">
              {candidates.map((candidate) => {
                const size = measurements[candidate.url];
                const isSelected = selected.includes(candidate.url);
                const blocked = tooSmall(candidate.url);
                return (
                  <button
                    key={candidate.url}
                    type="button"
                    onClick={() => !blocked && toggle(candidate.url)}
                    disabled={blocked}
                    aria-pressed={isSelected}
                    title={candidate.url}
                    className={cn(
                      'group relative overflow-hidden rounded-xl border bg-surface text-left shadow-2xs transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-verity',
                      isSelected ? 'border-verity ring-2 ring-verity/25' : 'border-border hover:border-border-strong',
                      blocked && 'cursor-not-allowed opacity-45'
                    )}
                  >
                    <div className="grid h-[112px] place-items-center overflow-hidden bg-surface-2">
                      {size === 'failed' ? (
                        <span className="px-2 text-center text-[10.5px] leading-tight text-text-3">
                          Không xem trước được
                          <br />
                          (trang chặn hotlink)
                        </span>
                      ) : (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={candidate.url}
                          alt=""
                          referrerPolicy="no-referrer"
                          onLoad={(event) =>
                            measure(candidate.url, {
                              width: event.currentTarget.naturalWidth,
                              height: event.currentTarget.naturalHeight,
                            })
                          }
                          onError={() => measure(candidate.url, 'failed')}
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                        />
                      )}
                    </div>
                    {isSelected ? (
                      <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-verity text-white shadow-xs">
                        <Check aria-hidden="true" className="h-3 w-3" />
                      </span>
                    ) : null}
                    <div className="flex items-center justify-between gap-1 border-t border-border-subtle px-2 py-1">
                      <span className="text-[10px] font-mono text-text-3">
                        {size && size !== 'failed' ? `${size.width}×${size.height}` : '—'}
                      </span>
                      {size && size !== 'failed' && Math.min(size.width, size.height) < WARN_DIMENSION ? (
                        <span className="text-[9.5px] font-bold text-warn">{blocked ? 'Quá nhỏ' : 'Nhỏ'}</span>
                      ) : (
                        <span className="text-[9.5px] font-semibold uppercase text-text-3">{candidate.source}</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {searched ? (
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-surface-2/40 p-3 sm:flex-row">
            <input
              value={manualUrl}
              onChange={(event) => setManualUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleAddManual();
              }}
              type="url"
              inputMode="url"
              placeholder="Hoặc dán thẳng link ảnh (.jpg, .webp…)"
              className={inputClassName}
            />
            <button
              type="button"
              onClick={handleAddManual}
              disabled={!manualUrl.trim()}
              className="inline-flex min-h-11 flex-none items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface px-4 text-[12.5px] font-bold text-text-1 shadow-xs transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Link2 aria-hidden="true" className="h-4 w-4" />
              Thêm ảnh
            </button>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11.5px] leading-relaxed text-text-3">
            Ảnh tải về giữ nguyên link nguồn để reviewer kiểm tra bản quyền trước khi công bố.
          </p>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={!selected.length || importing}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-verity px-5 text-[12.5px] font-bold text-white shadow-sm transition-colors hover:bg-verity-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download aria-hidden="true" className="h-4 w-4" />
            {importing ? 'Đang tải…' : `Tải ${selected.length || ''} ảnh vào lô`}
          </button>
        </div>
      </div>
    </ResponsiveDialogSheet>
  );
}
