'use client';

import React, { useState } from 'react';
import { MediaAsset } from '@/types/media';
import { VerityBadge } from '@/components/common/VerityBadge';
import { X, Sparkles, CheckCircle2, Trash2, Layers, RefreshCw, Calendar, Eye, ZoomIn } from 'lucide-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';

interface DuplicateCompareModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentAsset: MediaAsset;
  matchedAssets: MediaAsset[];
  similarity?: number;
  initialIndex?: number;
  onReplaceOld: (replaceIds: string[]) => void;
  onKeepBoth: () => void;
  onDropNew: () => void;
}

export function formatSimilarity(value?: number): string {
  if (value === undefined || value === null || value <= 0) return '0%';
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(2)}%`;
}

export function DuplicateCompareModal({
  isOpen,
  onClose,
  currentAsset,
  matchedAssets,
  similarity,
  initialIndex = 0,
  onReplaceOld,
  onKeepBoth,
  onDropNew,
}: DuplicateCompareModalProps) {
  const [selectedMatchIndex, setSelectedMatchIndex] = useState(initialIndex);
  const [isZoomNew, setIsZoomNew] = useState(false);
  const [isZoomOld, setIsZoomOld] = useState(false);

  // Sync selectedMatchIndex whenever the modal opens or the clicked initialIndex changes
  React.useEffect(() => {
    if (isOpen) {
      const safe = Math.min(
        Math.max(0, initialIndex ?? 0),
        Math.max(0, (matchedAssets?.length || 1) - 1)
      );
      setSelectedMatchIndex(safe);
      setIsZoomNew(false);
      setIsZoomOld(false);
    }
  }, [isOpen, initialIndex, matchedAssets?.length]);

  if (!isOpen || matchedAssets.length === 0) return null;

  const currentMatched = matchedAssets[selectedMatchIndex] || matchedAssets[0];
  const formattedSim = formatSimilarity(similarity);

  const handleReplaceClick = () => {
    onReplaceOld([currentMatched.id]);
    onClose();
  };

  const handleReplaceAllClick = () => {
    onReplaceOld(matchedAssets.map((m) => m.id));
    onClose();
  };

  const handleKeepBothClick = () => {
    onKeepBoth();
    onClose();
  };

  const handleDropNewClick = () => {
    onDropNew();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-xs p-3 sm:p-6 overflow-hidden animate-fadeIn select-none">
      <div className="relative w-full max-w-[1100px] max-h-[92vh] bg-surface border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden text-text-1">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 h-[60px] border-b border-border bg-surface-2/70 flex-none">
          <div className="flex items-center gap-3">
            <VerityBadge variant="gold" size="sm">
              Trùng lặp
            </VerityBadge>
            <div>
              <h3 className="text-[14.5px] font-bold text-text-1 flex items-center gap-2">
                <span>Đối chiếu ảnh trùng lặp</span>
                <span className="text-[11.5px] font-mono font-medium px-2 py-0.5 rounded-full bg-gold/15 text-amber-500 border border-gold/25">
                  Độ giống: {formattedSim}
                </span>
              </h3>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg grid place-items-center text-text-3 hover:text-text-1 hover:bg-hover transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Multi-match Selector Tabs with Visual Thumbnails */}
        {matchedAssets.length > 1 && (
          <div className="flex items-center gap-2 px-6 py-2 border-b border-border bg-surface-2/40 flex-none overflow-x-auto">
            <span className="text-[11.5px] text-text-3 font-semibold flex-none mr-1">
              Chọn ảnh đối chiếu ({matchedAssets.length} ảnh trùng):
            </span>
            {matchedAssets.map((m, idx) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  setSelectedMatchIndex(idx);
                  setIsZoomOld(false);
                }}
                className={cn(
                  'flex items-center gap-2 p-1.5 pr-3 rounded-xl text-[12px] font-semibold transition-all border flex-none cursor-pointer',
                  selectedMatchIndex === idx
                    ? 'bg-surface text-text-1 border-amber-500 ring-2 ring-amber-500/25 shadow-xs font-bold'
                    : 'bg-surface hover:bg-surface-2 text-text-2 border-border hover:border-border-strong'
                )}
              >
                <img
                  src={m.thumbnail_url || m.file_url}
                  alt={`Ảnh #${idx + 1}`}
                  className="w-7 h-7 rounded-lg object-cover bg-black/10 flex-none"
                />
                <span>Ảnh #{idx + 1} {m.sku ? `(${m.sku})` : ''}</span>
              </button>
            ))}
          </div>
        )}

        {/* Modal Body: Side-by-Side Comparison */}
        <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: New Uploaded Image */}
          <div className="flex flex-col gap-3 rounded-2xl border border-blue-500/30 bg-blue-500/5 p-4 relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-[13px] font-bold text-blue-500">
                  Ảnh mới tải lên (Đang duyệt)
                </span>
              </div>
              <span className="text-[11px] font-mono text-text-3">
                {currentAsset.sku || currentAsset.id.slice(0, 8)}
              </span>
            </div>

            {/* Image Preview Container */}
            <div
              className="relative rounded-xl overflow-hidden border border-border bg-black/10 flex items-center justify-center min-h-[260px] max-h-[360px] group cursor-pointer"
              onClick={() => setIsZoomNew(!isZoomNew)}
              title="Bấm để phóng to/thu nhỏ ảnh"
            >
              <img
                src={currentAsset.thumbnail_url || currentAsset.file_url}
                alt={currentAsset.title || 'Ảnh mới tải lên'}
                className={cn(
                  'w-full h-auto object-contain max-h-[360px] transition-transform duration-300',
                  isZoomNew && 'scale-150'
                )}
              />
              <div className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-xs text-white text-[10.5px] font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <ZoomIn className="w-3 h-3" />
                <span>{isZoomNew ? 'Thu nhỏ' : 'Phóng to'}</span>
              </div>
            </div>

            {/* Specs Table */}
            <div className="rounded-xl border border-border/80 bg-surface divide-y divide-border text-[12px]">
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">SKU đề xuất</span>
                <span className="font-mono font-bold text-text-1">
                  {currentAsset.sku || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Kích thước</span>
                <span className="font-mono text-text-1">
                  {currentAsset.dimensions?.width && currentAsset.dimensions?.height
                    ? `${currentAsset.dimensions.width} × ${currentAsset.dimensions.height}`
                    : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Dung lượng</span>
                <span className="font-mono text-text-1">
                  {formatBytes(currentAsset.dimensions?.size_bytes || 0)}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Thời gian nạp</span>
                <span className="text-text-2">
                  {formatDate(currentAsset.created_at)}
                </span>
              </div>
            </div>
          </div>

          {/* Right Column: Existing Matched Image */}
          <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                <span className="text-[13px] font-bold text-amber-500">
                  Ảnh hiện có trong kho (Đã lưu)
                </span>
              </div>
              <span className="text-[11px] font-mono text-text-3">
                {currentMatched.sku || currentMatched.id.slice(0, 8)}
              </span>
            </div>

            {/* Image Preview Container */}
            <div
              className="relative rounded-xl overflow-hidden border border-border bg-black/10 flex items-center justify-center min-h-[260px] max-h-[360px] group cursor-pointer"
              onClick={() => setIsZoomOld(!isZoomOld)}
              title="Bấm để phóng to/thu nhỏ ảnh"
            >
              <img
                src={currentMatched.thumbnail_url || currentMatched.file_url}
                alt={currentMatched.title || 'Ảnh trong kho'}
                className={cn(
                  'w-full h-auto object-contain max-h-[360px] transition-transform duration-300',
                  isZoomOld && 'scale-150'
                )}
              />
              <div className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-xs text-white text-[10.5px] font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <ZoomIn className="w-3 h-3" />
                <span>{isZoomOld ? 'Thu nhỏ' : 'Phóng to'}</span>
              </div>
            </div>

            {/* Specs Table */}
            <div className="rounded-xl border border-border/80 bg-surface divide-y divide-border text-[12px]">
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Mã SKU trong kho</span>
                <span className="font-mono font-bold text-text-1">
                  {currentMatched.sku || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Kích thước</span>
                <span className="font-mono text-text-1">
                  {currentMatched.dimensions?.width && currentMatched.dimensions?.height
                    ? `${currentMatched.dimensions.width} × ${currentMatched.dimensions.height}`
                    : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Dung lượng</span>
                <span className="font-mono text-text-1">
                  {formatBytes(currentMatched.dimensions?.size_bytes || 0)}
                </span>
              </div>
              <div className="flex items-center justify-between p-2">
                <span className="text-text-3 font-medium">Thời gian nạp</span>
                <span className="text-text-2">
                  {formatDate(currentMatched.created_at)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Modal Footer Actions: Directly aligned with left and right columns */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4 px-6 border-t border-border bg-surface-2/90 flex-none items-center">
          {/* Left Column Action: For New Image */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleReplaceClick}
              className="flex-1 flex items-center justify-center gap-2 h-[42px] px-4 rounded-xl bg-verity hover:bg-verity-hover text-white text-[13px] font-bold transition-all shadow-sm active:scale-[0.99] cursor-pointer"
              title="Duyệt ảnh mới và tự động xóa ảnh cũ đang đối chiếu"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Dùng ảnh mới này (Xóa ảnh cũ)</span>
            </button>
            {matchedAssets.length > 1 && (
              <button
                type="button"
                onClick={handleReplaceAllClick}
                className="flex items-center justify-center gap-1 h-[42px] px-3 rounded-xl border border-border bg-surface hover:bg-surface-2 text-text-2 hover:text-text-1 text-[11.5px] font-semibold transition-all shadow-xs cursor-pointer"
                title={`Xóa tất cả ${matchedAssets.length} ảnh trùng trong kho`}
              >
                <span>Xóa hết {matchedAssets.length} ảnh cũ</span>
              </button>
            )}
          </div>

          {/* Right Column Action: For Existing Image & Keep Both */}
          <div className="flex items-center gap-2.5">
            {/* Option 2: Keep Both */}
            <button
              type="button"
              onClick={handleKeepBothClick}
              className="flex-1 flex items-center justify-center gap-1.5 h-[42px] px-3 rounded-xl border border-border bg-surface hover:bg-surface-2 text-text-1 text-[12.5px] font-semibold transition-all shadow-xs cursor-pointer"
              title="Duyệt ảnh mới và giữ cả 2 ảnh trong kho"
            >
              <Layers className="w-3.5 h-3.5 text-text-3" />
              <span>Vẫn giữ cả 2</span>
            </button>

            {/* Option 3: Keep Old, Drop New */}
            <button
              type="button"
              onClick={handleDropNewClick}
              className="flex-1 flex items-center justify-center gap-1.5 h-[42px] px-3 rounded-xl border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-[12.5px] font-bold transition-all shadow-xs cursor-pointer"
              title="Bỏ ảnh mới vừa tải lên, giữ nguyên ảnh cũ trong kho"
            >
              <Trash2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
              <span>Giữ ảnh cũ (Bỏ ảnh mới)</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

