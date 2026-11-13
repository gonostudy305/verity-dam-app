'use client';

import React, { useEffect, useCallback } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Check,
  Globe,
  Sparkles,
  ImageIcon,
} from 'lucide-react';
import { VerityChip } from '@/components/common/VerityChip';
import type { ProductIntakeAsset, ProductIntakeAssetDecision } from '@/types/media';

export type ReferenceRole = 'HERO' | 'ANGLE';
export type ImageCategory = 'REAL' | 'STUDIO' | 'DESIGN';

export interface AssetChoice {
  decision: Exclude<ProductIntakeAssetDecision, 'pending'>;
  isReference: boolean;
  role?: ReferenceRole;
  imageCategory?: ImageCategory;
}

const ROLE_OPTIONS: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'HERO', label: 'Ảnh chính' },
  { value: 'ANGLE', label: 'Ảnh góc' },
];

const IMAGE_CATEGORY_OPTIONS: Array<{ value: ImageCategory; label: string }> = [
  { value: 'REAL', label: 'Ảnh thực tế' },
  { value: 'STUDIO', label: 'Ảnh Studio' },
  { value: 'DESIGN', label: 'Ảnh Thiết kế' },
];

interface ProductIntakeAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
  assets: ProductIntakeAsset[];
  currentIndex: number;
  onNavigate: (index: number) => void;
  choices: Record<string, AssetChoice>;
  onUpdateChoice: (assetId: string, updates: Partial<AssetChoice>) => void;
  titles: Record<string, string>;
  onSaveTitle: (assetId: string, title: string) => void;
  onApplyAiSuggestion?: (asset: ProductIntakeAsset) => void;
  locked?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ProductIntakeAssetModal({
  isOpen,
  onClose,
  assets,
  currentIndex,
  onNavigate,
  choices,
  onUpdateChoice,
  titles,
  onSaveTitle,
  onApplyAiSuggestion,
  locked = false,
}: ProductIntakeAssetModalProps) {
  const currentAsset = assets[currentIndex];

  const handlePrev = useCallback(() => {
    if (assets.length <= 1) return;
    onNavigate(currentIndex > 0 ? currentIndex - 1 : assets.length - 1);
  }, [assets.length, currentIndex, onNavigate]);

  const handleNext = useCallback(() => {
    if (assets.length <= 1) return;
    onNavigate(currentIndex < assets.length - 1 ? currentIndex + 1 : 0);
  }, [assets.length, currentIndex, onNavigate]);

  const currentChoice: AssetChoice = currentAsset
    ? choices[currentAsset.media_asset_id] || { decision: 'approved', isReference: false }
    : { decision: 'approved', isReference: false };

  const currentTitle = currentAsset
    ? titles[currentAsset.media_asset_id] ?? (currentAsset.title || '')
    : '';

  const referenceAssetType = currentAsset
    ? ['photo', 'render', 'screenshot'].includes(String(currentAsset.media_type))
    : false;

  const referenceEligible =
    !locked &&
    currentChoice.decision === 'approved' &&
    currentAsset?.ingest_status === 'ready' &&
    referenceAssetType;

  // Keyboard navigation & decision shortcuts
  useEffect(() => {
    if (!isOpen || !currentAsset) return;

    const onKeyDown = (e: KeyboardEvent) => {
      // Don't trigger decision hotkeys if typing in an input
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') {
          target.blur();
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (e.key === '1' || e.key.toLowerCase() === 'a') {
        if (!locked) {
          e.preventDefault();
          onUpdateChoice(currentAsset.media_asset_id, { decision: 'approved' });
        }
      } else if (e.key === '2' || e.key.toLowerCase() === 'r') {
        if (!locked) {
          e.preventDefault();
          onUpdateChoice(currentAsset.media_asset_id, { decision: 'rejected' });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, currentAsset, locked, onClose, handlePrev, handleNext, onUpdateChoice]);

  if (!isOpen || !currentAsset) return null;

  const imageUrl = currentAsset.thumbnail_url;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Xem chi tiết ảnh ${currentTitle || currentAsset.media_asset_id}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/92 backdrop-blur-xs select-none animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top Header */}
      <div className="flex h-14 flex-none items-center justify-between border-b border-white/10 px-4 text-white">
        <div className="flex items-center gap-3 min-w-0">
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-white/90">
            {currentIndex + 1} / {assets.length}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-white/95" title={currentTitle || currentAsset.media_asset_id}>
              {currentTitle || currentAsset.title || 'Ảnh chưa có tiêu đề'}
            </p>
            <div className="flex items-center gap-2 text-[11px] text-white/60">
              <span>{currentAsset.ingest_error ? 'Lỗi xử lý' : currentAsset.ingest_status || 'Đã tải lên'}</span>
              {currentAsset.source_url && (
                <span className="flex items-center gap-1 text-amber-300">
                  <Globe className="h-3 w-3" />
                  <a
                    href={currentAsset.source_url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="underline decoration-dotted hover:text-white"
                  >
                    {hostOf(currentAsset.source_url)}
                  </a>
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-[11.5px] text-white/40 font-mono">
            Phím 1: Giữ · 2: Loại · ← / →: Chuyển ảnh
          </span>
          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg bg-white/10 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
            title="Đóng (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main Image Stage */}
      <div className="relative flex flex-1 items-center justify-center p-4 overflow-hidden">
        {assets.length > 1 && (
          <>
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-3 z-10 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur-xs transition-all hover:bg-black/90 hover:text-white hover:scale-105"
              title="Ảnh trước (←)"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-3 z-10 grid h-11 w-11 place-items-center rounded-full bg-black/60 text-white/80 backdrop-blur-xs transition-all hover:bg-black/90 hover:text-white hover:scale-105"
              title="Ảnh tiếp theo (→)"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}

        <div className="flex h-full max-h-[60vh] sm:max-h-[64vh] w-full max-w-[90vw] items-center justify-center">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={currentTitle || 'Chi tiết ảnh'}
              className="max-h-full max-w-full rounded-xl object-contain shadow-2xl transition-all"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 text-white/40">
              <ImageIcon className="h-12 w-12" />
              <p className="text-[13px]">Không tải được bản xem trước ảnh</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Decision Dock */}
      <div className="flex-none border-t border-white/10 bg-black/75 p-3.5 sm:p-4 backdrop-blur-md">
        <div className="mx-auto max-w-4xl space-y-3">
          {/* Row 1: Title & AI metadata */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-1 items-center gap-2 min-w-0">
              <input
                value={currentTitle}
                onChange={(e) => onSaveTitle(currentAsset.media_asset_id, e.target.value)}
                disabled={locked}
                placeholder="Tiêu đề ảnh"
                className="h-10 w-full rounded-xl border border-white/15 bg-white/10 px-3 text-[12.5px] text-white placeholder:text-white/40 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {!locked && currentAsset.suggested_caption && onApplyAiSuggestion && (
                <button
                  type="button"
                  onClick={() => onApplyAiSuggestion(currentAsset)}
                  title={currentAsset.suggested_caption}
                  className="flex h-10 flex-none items-center gap-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/20 px-3 text-[12px] font-semibold text-cyan-300 transition-colors hover:bg-cyan-500/30 hover:text-white"
                >
                  <Sparkles className="h-4 w-4" />
                  <span className="hidden sm:inline">Gợi ý AI</span>
                </button>
              )}
            </div>

            {currentAsset.sku_match?.sku && (
              <span className="shrink-0 rounded-lg bg-cyan-950/80 border border-cyan-500/30 px-2.5 py-1 text-[11.5px] font-medium text-cyan-300">
                AI gợi ý SKU: <strong>{currentAsset.sku_match.sku}</strong>
                {currentAsset.sku_match.requires_reviewer_confirmation ? ' (cần xác minh)' : ''}
              </span>
            )}
          </div>

          {currentAsset.suggested_caption && (
            <p className="line-clamp-2 text-[11.5px] leading-relaxed text-white/70">
              {currentAsset.suggested_caption}
            </p>
          )}

          {/* Row 2: Decision Actions & Reference Selection */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-white/10">
            {/* Giữ / Loại Buttons */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={locked}
                onClick={() => onUpdateChoice(currentAsset.media_asset_id, { decision: 'approved' })}
                className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-5 text-[13px] font-bold transition-all shadow-sm ${
                  currentChoice.decision === 'approved'
                    ? 'border border-emerald-500 bg-emerald-600 text-white ring-2 ring-emerald-400/40'
                    : 'border border-white/20 bg-white/10 text-white/80 hover:bg-white/20 hover:text-white'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Check className="h-4 w-4" />
                <span>Giữ (Phím 1)</span>
              </button>

              <button
                type="button"
                disabled={locked}
                onClick={() => onUpdateChoice(currentAsset.media_asset_id, { decision: 'rejected' })}
                className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-5 text-[13px] font-bold transition-all shadow-sm ${
                  currentChoice.decision === 'rejected'
                    ? 'border border-red-500 bg-red-600 text-white ring-2 ring-red-400/40'
                    : 'border border-white/20 bg-white/10 text-white/80 hover:bg-white/20 hover:text-white'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <X className="h-4 w-4" />
                <span>Loại (Phím 2)</span>
              </button>
            </div>

            {/* Reference Settings */}
            <div className="flex flex-wrap items-center gap-2">
              <label
                className={`inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-[12px] font-semibold transition-colors ${
                  referenceEligible
                    ? 'cursor-pointer border border-cyan-500/30 bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25'
                    : 'cursor-not-allowed border border-white/10 bg-white/5 text-white/40'
                }`}
              >
                <input
                  type="checkbox"
                  checked={currentChoice.isReference}
                  disabled={!referenceEligible}
                  onChange={(e) =>
                    onUpdateChoice(currentAsset.media_asset_id, { isReference: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-white/30 text-cyan-500 focus:ring-cyan-400"
                />
                <span>
                  {!referenceAssetType
                    ? 'Video không làm mẫu'
                    : currentAsset.ingest_status === 'ready'
                    ? 'Dùng làm ảnh mẫu'
                    : 'Chờ xử lý xong'}
                </span>
              </label>

              {referenceEligible && currentChoice.isReference && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-xl bg-white/10 p-1">
                    {ROLE_OPTIONS.map((opt) => (
                      <VerityChip
                        key={opt.value}
                        active={currentChoice.role === opt.value}
                        onClick={() =>
                          onUpdateChoice(currentAsset.media_asset_id, {
                            role: currentChoice.role === opt.value ? undefined : opt.value,
                          })
                        }
                      >
                        {opt.label}
                      </VerityChip>
                    ))}
                  </div>

                  <div className="flex items-center gap-1 rounded-xl bg-white/10 p-1">
                    {IMAGE_CATEGORY_OPTIONS.map((opt) => (
                      <VerityChip
                        key={opt.value}
                        active={currentChoice.imageCategory === opt.value}
                        onClick={() =>
                          onUpdateChoice(currentAsset.media_asset_id, {
                            imageCategory:
                              currentChoice.imageCategory === opt.value ? undefined : opt.value,
                          })
                        }
                      >
                        {opt.label}
                      </VerityChip>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
