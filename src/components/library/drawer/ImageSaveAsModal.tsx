'use client';

import React, { useState, useEffect, useRef } from 'react';
import { X, Download, FileImage, Loader2 } from 'lucide-react';
import { cn, formatBytes } from '@/lib/utils';
import type { MediaAsset } from '@/types/media';
import {
  buildSmartFilename,
  sanitizeWindowsFilename,
  sanitizeFilenameInput,
  removeVietnameseAccents,
  type ExportFormat,
} from '@/hooks/useImageExport';

export interface ImageSaveAsModalProps {
  isOpen: boolean;
  onClose: () => void;
  asset: MediaAsset;
  onConfirmDownload: (customFilename: string, format: ExportFormat) => Promise<void>;
  isExporting?: boolean;
}

export function ImageSaveAsModal({
  isOpen,
  onClose,
  asset,
  onConfirmDownload,
  isExporting = false,
}: ImageSaveAsModalProps) {
  const [exportFormat, setExportFormat] = useState<ExportFormat>('webp');
  const [filenameBase, setFilenameBase] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize and pre-fill clean filename when modal opens
  useEffect(() => {
    if (isOpen && asset) {
      const extMatch = asset.file_url?.split(/[#?]/)[0].split('.').pop()?.toLowerCase();
      const initialFormat: ExportFormat =
        extMatch === 'png' ? 'png' : extMatch === 'jpg' || extMatch === 'jpeg' ? 'jpg' : 'webp';
      setExportFormat(initialFormat);

      const defaultFullName = buildSmartFilename(asset, 'original', initialFormat);
      const lastDot = defaultFullName.lastIndexOf('.');
      const base = lastDot > 0 ? defaultFullName.slice(0, lastDot) : defaultFullName;

      setFilenameBase(sanitizeFilenameInput(base));

      // Auto-focus input and select text for effortless renaming
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 50);
    }
  }, [isOpen, asset]);

  // Keyboard shortcut: Enter to download, Esc to cancel
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && !isExporting) {
        e.preventDefault();
        void handleDownload();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, filenameBase, exportFormat, isExporting]);

  if (!isOpen) return null;

  const handleFilenameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Tự động làm sạch dấu tiếng Việt và ký tự cấm Windows (\ / : * ? " < > |)
    const cleaned = sanitizeFilenameInput(e.target.value);
    setFilenameBase(cleaned);
  };

  const handleFilenameBlur = () => {
    setFilenameBase((prev) => removeVietnameseAccents(prev).trim());
  };

  const handleDownload = async () => {
    const rawName = filenameBase.trim();
    const sanitized = sanitizeWindowsFilename(
      rawName ? `${rawName}.${exportFormat}` : `VERITY_${asset.sku || asset.id.slice(0, 8)}.${exportFormat}`,
      exportFormat
    );

    await onConfirmDownload(sanitized, exportFormat);
  };

  const previewDimensions = asset.dimensions?.width && asset.dimensions?.height
    ? `${asset.dimensions.width} × ${asset.dimensions.height} px`
    : null;
  const previewSize = asset.dimensions?.size_bytes ? formatBytes(asset.dimensions.size_bytes) : null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity animate-fadeIn"
        onClick={isExporting ? undefined : onClose}
      />

      {/* Dialog Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-title"
        className="relative z-10 w-full max-w-[480px] rounded-2xl border border-border bg-surface shadow-2xl overflow-hidden animate-scaleIn flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-surface-2/60 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-verity/10 text-verity grid place-items-center flex-none">
              <Download className="w-4 h-4" />
            </div>
            <div>
              <h3 id="save-as-title" className="text-[14px] font-bold text-text-1 leading-tight">
                Lưu ảnh về máy
              </h3>
              <p className="text-[11px] text-text-3">
                Lựa chọn định dạng và đổi tên tập tin trước khi tải xuống
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isExporting}
            onClick={onClose}
            aria-label="Đóng"
            className="w-8 h-8 rounded-lg grid place-items-center text-text-3 hover:bg-hover hover:text-text-1 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 space-y-4">
          {/* Asset Snapshot Card */}
          <div className="flex items-center gap-3 p-3 rounded-xl border border-border/80 bg-surface-2/40">
            <div className="relative w-14 h-14 rounded-lg overflow-hidden border border-border bg-black/5 flex-none">
              <img
                src={asset.thumbnail_url || asset.file_url}
                alt={asset.title}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[12px] font-bold text-text-1 px-1.5 py-0.5 rounded bg-surface border border-border">
                  {asset.sku || asset.id.slice(0, 8)}
                </span>
                {asset.brand && (
                  <span className="text-[11px] font-semibold text-text-2 truncate">
                    {asset.brand}
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-text-3 font-mono">
                {previewDimensions && <span>{previewDimensions}</span>}
                {previewSize && <span>· {previewSize}</span>}
              </div>
            </div>
          </div>

          {/* Format Selector */}
          <div className="space-y-1.5">
            <label className="block text-[11.5px] font-bold text-text-2 uppercase tracking-wider">
              Định dạng tải về
            </label>
            <div className="grid grid-cols-3 gap-2">
              {/* WebP */}
              <button
                type="button"
                onClick={() => setExportFormat('webp')}
                className={cn(
                  'flex flex-col items-start p-2.5 rounded-xl border text-left transition-all cursor-pointer select-none relative',
                  exportFormat === 'webp'
                    ? 'border-verity bg-verity/5 text-text-1 shadow-2xs ring-1 ring-verity/20'
                    : 'border-border bg-surface text-text-2 hover:bg-hover hover:border-text-3/40'
                )}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[13px] font-bold tracking-tight text-text-1">WebP</span>
                  <span
                    className={cn(
                      'text-[9.5px] font-bold px-1.5 py-0.5 rounded-md leading-none',
                      exportFormat === 'webp' ? 'bg-verity text-white' : 'bg-surface-2 text-text-3'
                    )}
                  >
                    Gốc
                  </span>
                </div>
                <div className="text-[10.5px] text-text-3 leading-snug truncate w-full">
                  Chuẩn Web · Siêu nhẹ
                </div>
              </button>

              {/* JPG */}
              <button
                type="button"
                onClick={() => setExportFormat('jpg')}
                className={cn(
                  'flex flex-col items-start p-2.5 rounded-xl border text-left transition-all cursor-pointer select-none relative',
                  exportFormat === 'jpg'
                    ? 'border-verity bg-verity/5 text-text-1 shadow-2xs ring-1 ring-verity/20'
                    : 'border-border bg-surface text-text-2 hover:bg-hover hover:border-text-3/40'
                )}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[13px] font-bold tracking-tight text-text-1">JPG</span>
                  <span
                    className={cn(
                      'text-[9.5px] font-bold px-1.5 py-0.5 rounded-md leading-none',
                      exportFormat === 'jpg' ? 'bg-verity text-white' : 'bg-surface-2 text-text-3'
                    )}
                  >
                    Phổ biến
                  </span>
                </div>
                <div className="text-[10.5px] text-text-3 leading-snug truncate w-full">
                  Zalo · Word · PTS
                </div>
              </button>

              {/* PNG */}
              <button
                type="button"
                onClick={() => setExportFormat('png')}
                className={cn(
                  'flex flex-col items-start p-2.5 rounded-xl border text-left transition-all cursor-pointer select-none relative',
                  exportFormat === 'png'
                    ? 'border-verity bg-verity/5 text-text-1 shadow-2xs ring-1 ring-verity/20'
                    : 'border-border bg-surface text-text-2 hover:bg-hover hover:border-text-3/40'
                )}
              >
                <div className="flex items-center justify-between w-full mb-1">
                  <span className="text-[13px] font-bold tracking-tight text-text-1">PNG</span>
                  <span
                    className={cn(
                      'text-[9.5px] font-bold px-1.5 py-0.5 rounded-md leading-none',
                      exportFormat === 'png' ? 'bg-verity text-white' : 'bg-surface-2 text-text-3'
                    )}
                  >
                    Nét cao
                  </span>
                </div>
                <div className="text-[10.5px] text-text-3 leading-snug truncate w-full">
                  Giữ nền trong suốt
                </div>
              </button>
            </div>
          </div>

          {/* File Name Input */}
          <div className="space-y-1.5">
            <label htmlFor="save-as-filename" className="block text-[11.5px] font-bold text-text-2 uppercase tracking-wider">
              Tên tập tin (Có thể chỉnh sửa)
            </label>
            <div className="relative flex items-center rounded-xl border border-border bg-surface shadow-2xs focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20 transition-all">
              <div className="pl-3 pr-1.5 text-text-3 flex-none">
                <FileImage className="w-4 h-4" />
              </div>
              <input
                id="save-as-filename"
                ref={inputRef}
                type="text"
                value={filenameBase}
                onChange={handleFilenameChange}
                onBlur={handleFilenameBlur}
                disabled={isExporting}
                placeholder="Nhập tên ảnh..."
                className="w-full py-2.5 text-[13px] font-medium text-text-1 bg-transparent border-0 outline-none placeholder:text-text-3 font-mono"
              />
              <span className="pr-3 pl-1 text-[12px] font-mono font-bold text-text-3 flex-none select-none">
                .{exportFormat}
              </span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/60 px-5 py-3.5">
          <button
            type="button"
            disabled={isExporting}
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-border text-[12.5px] font-semibold text-text-2 hover:bg-hover hover:text-text-1 transition-all disabled:opacity-50 cursor-pointer"
          >
            Hủy (Esc)
          </button>
          <button
            type="button"
            disabled={isExporting}
            onClick={() => void handleDownload()}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-verity hover:bg-verity-hover text-white text-[13px] font-bold transition-all shadow-sm disabled:opacity-60 active:scale-[0.98] cursor-pointer"
          >
            {isExporting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Đang xử lý...</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4 stroke-[2.5]" />
                <span>Tải về (Enter)</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
