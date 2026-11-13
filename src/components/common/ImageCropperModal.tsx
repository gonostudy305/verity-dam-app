'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  RotateCw,
  Download,
  Copy,
  Sparkles,
  Crop,
  Layers,
  Check,
  Save,
  CheckCircle2,
  BookmarkCheck,
  Loader2
} from 'lucide-react';
import { useToast } from '@/components/common/Toast';
import { apiRequest } from '@/lib/client/api';
import type { CropConfig } from '@/types/media';
import { cn } from '@/lib/utils';

export interface CropPreset {
  id: string;
  label: string;
  ratio: number | null; // null for freeform, e.g. 1 for 1:1, 9/16, 16/9, 4/5
  description: string;
}

export const CROP_PRESETS: CropPreset[] = [
  { id: '1:1', label: '1:1', ratio: 1, description: 'Vuông (Post Facebook / Instagram)' },
  { id: '9:16', label: '9:16', ratio: 9 / 16, description: 'Dọc (Story / TikTok / Reels)' },
  { id: '16:9', label: '16:9', ratio: 16 / 9, description: 'Ngang (Banner Web / YouTube)' },
  { id: '4:5', label: '4:5', ratio: 4 / 5, description: 'Dọc Feed (Instagram Post)' },
  { id: 'free', label: 'Tự do', ratio: null, description: 'Tùy chỉnh không giới hạn' },
];

interface ImageCropperModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageUrl: string;
  imageTitle?: string;
  initialPresetId?: string;
  assetId?: string;
  savedCropConfigs?: Record<string, CropConfig>;
  onCropSaved?: (presetId: string, crop: CropConfig) => void;
}

interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type DragMode = 'move' | 'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w';

export function ImageCropperModal({
  isOpen,
  onClose,
  imageUrl,
  imageTitle = 'image',
  initialPresetId = '1:1',
  assetId,
  savedCropConfigs,
  onCropSaved,
}: ImageCropperModalProps) {
  const { showToast } = useToast();

  const [activePreset, setActivePreset] = useState<string>(initialPresetId);
  const [rotation, setRotation] = useState<number>(0);
  const [isRounded, setIsRounded] = useState<boolean>(false);
  const [borderRadius, setBorderRadius] = useState<number>(16);

  const [imgNaturalSize, setImgNaturalSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropBox>({ x: 0, y: 0, width: 0, height: 0 });
  const [imageLoaded, setImageLoaded] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const [localSavedCrops, setLocalSavedCrops] = useState<Record<string, CropConfig>>(savedCropConfigs || {});

  useEffect(() => {
    if (savedCropConfigs) {
      setLocalSavedCrops(savedCropConfigs);
    }
  }, [savedCropConfigs]);

  const imageRef = useRef<HTMLImageElement>(null);
  const cropRef = useRef<CropBox>(crop);
  cropRef.current = crop;

  const dragSessionRef = useRef<{
    mode: DragMode;
    startClientX: number;
    startClientY: number;
    startCrop: CropBox;
    imageRect: DOMRect;
    naturalWidth: number;
    naturalHeight: number;
    ratio: number | null;
  } | null>(null);

  // Calculate AI Auto-Center algorithm
  const calculateAiCrop = useCallback(
    (presetId: string, naturalW: number, naturalH: number): CropBox => {
      const preset = CROP_PRESETS.find((p) => p.id === presetId) || CROP_PRESETS[0];
      if (preset.ratio === null) {
        const w = Math.round(naturalW * 0.85);
        const h = Math.round(naturalH * 0.85);
        return {
          x: Math.round((naturalW - w) / 2),
          y: Math.round((naturalH - h) / 2),
          width: w,
          height: h,
        };
      }

      const imgRatio = naturalW / naturalH;
      const targetRatio = preset.ratio;

      let cropW = 0;
      let cropH = 0;

      if (imgRatio > targetRatio) {
        cropH = Math.round(naturalH * 0.95);
        cropW = Math.round(cropH * targetRatio);
      } else {
        cropW = Math.round(naturalW * 0.95);
        cropH = Math.round(cropW / targetRatio);
      }

      cropW = Math.max(20, Math.min(cropW, naturalW));
      cropH = Math.max(20, Math.min(cropH, naturalH));

      const cropX = Math.max(0, Math.round((naturalW - cropW) / 2));
      const cropY = Math.max(0, Math.round((naturalH - cropH) / 2));

      return { x: cropX, y: cropY, width: cropW, height: cropH };
    },
    []
  );

  // Apply crop for preset (either from saved config or AI default)
  const applyPresetCrop = useCallback(
    (presetId: string, naturalW: number, naturalH: number, savedMap: Record<string, CropConfig>) => {
      const saved = savedMap[presetId];
      if (saved && saved.width > 0 && saved.height > 0) {
        setCrop({
          x: Math.min(saved.x, Math.max(0, naturalW - saved.width)),
          y: Math.min(saved.y, Math.max(0, naturalH - saved.height)),
          width: Math.min(saved.width, naturalW),
          height: Math.min(saved.height, naturalH),
        });
        setRotation(saved.rotation || 0);
        setIsRounded(Boolean(saved.is_rounded));
        setBorderRadius(saved.border_radius || 16);
      } else {
        const aiCrop = calculateAiCrop(presetId, naturalW, naturalH);
        setCrop(aiCrop);
        setRotation(0);
        setIsRounded(false);
      }
    },
    [calculateAiCrop]
  );

  // Sync active preset when initialPresetId changes
  useEffect(() => {
    if (isOpen) {
      setActivePreset(initialPresetId);
      if (imgNaturalSize.width > 0 && imgNaturalSize.height > 0) {
        applyPresetCrop(initialPresetId, imgNaturalSize.width, imgNaturalSize.height, localSavedCrops);
      }
    }
  }, [isOpen, initialPresetId, applyPresetCrop, imgNaturalSize.width, imgNaturalSize.height, localSavedCrops]);

  // Initialize on image load
  const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const naturalW = img.naturalWidth || 800;
    const naturalH = img.naturalHeight || 600;
    setImgNaturalSize({ width: naturalW, height: naturalH });
    setImageLoaded(true);

    applyPresetCrop(activePreset, naturalW, naturalH, localSavedCrops);
  };

  // Change preset
  const handlePresetChange = (presetId: string) => {
    setActivePreset(presetId);
    if (imgNaturalSize.width > 0 && imgNaturalSize.height > 0) {
      applyPresetCrop(presetId, imgNaturalSize.width, imgNaturalSize.height, localSavedCrops);
    }
  };

  // AI Auto-Center click
  const handleAiAutoCenter = () => {
    if (imgNaturalSize.width > 0 && imgNaturalSize.height > 0) {
      const newCrop = calculateAiCrop(activePreset, imgNaturalSize.width, imgNaturalSize.height);
      setCrop(newCrop);
      showToast('AI đã tự động căn tâm và tối ưu tỷ lệ', 'success');
    }
  };

  // Save Crop Configuration for the Team
  const handleSaveCropConfig = async () => {
    if (!assetId) {
      showToast('Không có ID asset để lưu cấu hình', 'warn');
      return;
    }
    setIsSaving(true);
    try {
      const payload: CropConfig = {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        rotation,
        is_rounded: isRounded,
        border_radius: borderRadius,
      };

      let res: { success: boolean; data?: Record<string, CropConfig> } | null = null;
      try {
        res = await apiRequest<{ success: boolean; data: Record<string, CropConfig> }>(
          `/api/media/${assetId}/crop`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ presetId: activePreset, crop: payload }),
          }
        );
      } catch {
        res = await apiRequest<{ success: boolean; data: Record<string, CropConfig> }>(
          `/api/media/${assetId}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ presetId: activePreset, crop: payload }),
          }
        );
      }

      if (res && res.success && res.data) {
        setLocalSavedCrops(res.data);
        onCropSaved?.(activePreset, payload);
        showToast(`Đã lưu cấu hình tỷ lệ ${activePreset} cho team! Người sau mở ra sẽ thấy ngay.`, 'success');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Có lỗi khi lưu cấu hình', 'warn');
    } finally {
      setIsSaving(false);
    }
  };

  // Manual numeric input change
  const handleCoordinateChange = (field: keyof CropBox, value: number) => {
    const naturalW = imgNaturalSize.width || 1000;
    const naturalH = imgNaturalSize.height || 1000;
    const currentPreset = CROP_PRESETS.find((p) => p.id === activePreset);
    const ratio = currentPreset?.ratio ?? null;

    setCrop((prev) => {
      let next = { ...prev, [field]: Math.max(0, Math.round(value)) };

      if (ratio !== null) {
        if (field === 'width') {
          next.height = Math.round(next.width / ratio);
        } else if (field === 'height') {
          next.width = Math.round(next.height * ratio);
        }
      }

      // Clamp within image bounds
      next.width = Math.min(next.width, naturalW);
      next.height = Math.min(next.height, naturalH);
      if (next.x + next.width > naturalW) next.x = Math.max(0, naturalW - next.width);
      if (next.y + next.height > naturalH) next.y = Math.max(0, naturalH - next.height);

      return next;
    });
  };

  // Rotate
  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleReset = () => {
    if (imgNaturalSize.width === 0 || imgNaturalSize.height === 0) return;
    setCrop(calculateAiCrop(activePreset, imgNaturalSize.width, imgNaturalSize.height));
    setRotation(0);
    setIsRounded(false);
    setBorderRadius(16);
  };

  // ── Global Window Dragging System ──
  const handlePointerDown = (mode: DragMode, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!imageRef.current || imgNaturalSize.width === 0) return;

    const imgElem = imageRef.current;
    const imageRect = imgElem.getBoundingClientRect();
    const preset = CROP_PRESETS.find((p) => p.id === activePreset);

    dragSessionRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCrop: { ...cropRef.current },
      imageRect,
      naturalWidth: imgNaturalSize.width,
      naturalHeight: imgNaturalSize.height,
      ratio: preset?.ratio ?? null,
    };

    const handleGlobalPointerMove = (moveEvt: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session) return;

      const { mode, startClientX, startClientY, startCrop, imageRect, naturalWidth, naturalHeight, ratio } = session;
      if (imageRect.width <= 0 || imageRect.height <= 0) return;

      const scaleX = naturalWidth / imageRect.width;
      const scaleY = naturalHeight / imageRect.height;

      const deltaX = (moveEvt.clientX - startClientX) * scaleX;
      const deltaY = (moveEvt.clientY - startClientY) * scaleY;

      const MIN_SIZE = 30;

      if (mode === 'move') {
        const maxAllowedX = Math.max(0, naturalWidth - startCrop.width);
        const maxAllowedY = Math.max(0, naturalHeight - startCrop.height);

        const newX = Math.max(0, Math.min(maxAllowedX, startCrop.x + deltaX));
        const newY = Math.max(0, Math.min(maxAllowedY, startCrop.y + deltaY));

        setCrop({
          x: Math.round(newX),
          y: Math.round(newY),
          width: startCrop.width,
          height: startCrop.height,
        });
      } else {
        let left = startCrop.x;
        let top = startCrop.y;
        let right = startCrop.x + startCrop.width;
        let bottom = startCrop.y + startCrop.height;

        if (mode.includes('e')) right = Math.min(naturalWidth, Math.max(left + MIN_SIZE, startCrop.x + startCrop.width + deltaX));
        if (mode.includes('w')) left = Math.max(0, Math.min(right - MIN_SIZE, startCrop.x + deltaX));
        if (mode.includes('s')) bottom = Math.min(naturalHeight, Math.max(top + MIN_SIZE, startCrop.y + startCrop.height + deltaY));
        if (mode.includes('n')) top = Math.max(0, Math.min(bottom - MIN_SIZE, startCrop.y + deltaY));

        let newW = right - left;
        let newH = bottom - top;

        if (ratio !== null) {
          if (mode === 'e' || mode === 'w' || mode === 'se' || mode === 'sw') {
            newH = newW / ratio;
            if (mode.includes('n')) {
              top = bottom - newH;
              if (top < 0) {
                top = 0;
                newH = bottom;
                newW = newH * ratio;
                if (mode.includes('w')) left = right - newW;
                else right = left + newW;
              }
            } else {
              bottom = top + newH;
              if (bottom > naturalHeight) {
                bottom = naturalHeight;
                newH = bottom - top;
                newW = newH * ratio;
                if (mode.includes('w')) left = right - newW;
                else right = left + newW;
              }
            }
          } else {
            newW = newH * ratio;
            if (mode.includes('w')) {
              left = right - newW;
              if (left < 0) {
                left = 0;
                newW = right;
                newH = newW / ratio;
                if (mode.includes('n')) top = bottom - newH;
                else bottom = top + newH;
              }
            } else {
              right = left + newW;
              if (right > naturalWidth) {
                right = naturalWidth;
                newW = right - left;
                newH = newW / ratio;
                if (mode.includes('n')) top = bottom - newH;
                else bottom = top + newH;
              }
            }
          }
        }

        left = Math.max(0, Math.min(naturalWidth - MIN_SIZE, left));
        top = Math.max(0, Math.min(naturalHeight - MIN_SIZE, top));
        newW = Math.max(MIN_SIZE, Math.min(naturalWidth - left, newW));
        newH = Math.max(MIN_SIZE, Math.min(naturalHeight - top, newH));

        setCrop({
          x: Math.round(left),
          y: Math.round(top),
          width: Math.round(newW),
          height: Math.round(newH),
        });
      }
    };

    const handleGlobalPointerUp = () => {
      dragSessionRef.current = null;
      window.removeEventListener('pointermove', handleGlobalPointerMove);
      window.removeEventListener('pointerup', handleGlobalPointerUp);
      window.removeEventListener('pointercancel', handleGlobalPointerUp);
    };

    window.addEventListener('pointermove', handleGlobalPointerMove, { passive: true });
    window.addEventListener('pointerup', handleGlobalPointerUp);
    window.addEventListener('pointercancel', handleGlobalPointerUp);
  };

  // ── Render High-Resolution Canvas for Export ──
  const generateCroppedCanvas = useCallback((): Promise<HTMLCanvasElement> => {
    return new Promise((resolve, reject) => {
      const currentCrop = cropRef.current;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const naturalW = img.naturalWidth || 1000;
        const naturalH = img.naturalHeight || 1000;
        const safeX = Math.max(0, Math.floor(currentCrop.x));
        const safeY = Math.max(0, Math.floor(currentCrop.y));
        const safeW = Math.max(1, Math.min(Math.floor(currentCrop.width), naturalW - safeX));
        const safeH = Math.max(1, Math.min(Math.floor(currentCrop.height), naturalH - safeY));

        const canvas = document.createElement('canvas');
        canvas.width = safeW;
        canvas.height = safeH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable'));
          return;
        }

        if (isRounded) {
          const radius = (Math.min(safeW, safeH) * (borderRadius / 100)) / 2;
          ctx.beginPath();
          ctx.moveTo(radius, 0);
          ctx.lineTo(safeW - radius, 0);
          ctx.quadraticCurveTo(safeW, 0, safeW, radius);
          ctx.lineTo(safeW, safeH - radius);
          ctx.quadraticCurveTo(safeW, safeH, safeW - radius, safeH);
          ctx.lineTo(radius, safeH);
          ctx.quadraticCurveTo(0, safeH, 0, safeH - radius);
          ctx.lineTo(0, radius);
          ctx.quadraticCurveTo(0, 0, radius, 0);
          ctx.closePath();
          ctx.clip();
        }

        ctx.drawImage(
          img,
          safeX,
          safeY,
          safeW,
          safeH,
          0,
          0,
          safeW,
          safeH
        );
        resolve(canvas);
      };
      img.onerror = () => reject(new Error('Không thể nạp dữ liệu ảnh gốc để xuất bản.'));
      img.src = imageUrl;
    });
  }, [imageUrl, isRounded, borderRadius]);

  // Download Cropped Image
  const handleDownload = async () => {
    setIsExporting(true);
    try {
      const canvas = await generateCroppedCanvas();
      const link = document.createElement('a');
      link.download = `${imageTitle.replace(/\.[^/.]+$/, '')}-crop-${activePreset.replace(':', 'x')}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      showToast('Đã tải ảnh cắt độ phân giải cao về máy thành công', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Có lỗi khi xuất ảnh', 'warn');
    } finally {
      setIsExporting(false);
    }
  };

  // Copy Cropped Image to Clipboard
  const handleCopyClipboard = async () => {
    setIsExporting(true);
    try {
      const canvas = await generateCroppedCanvas();
      canvas.toBlob(async (blob) => {
        if (!blob) throw new Error('Không thể tạo blob ảnh');
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        showToast('Đã sao chép ảnh cắt vào Clipboard (có thể dán trực tiếp Ctrl+V)', 'success');
        setIsExporting(false);
      }, 'image/png');
    } catch (err) {
      showToast('Trình duyệt không hỗ trợ sao chép ảnh bitmap trực tiếp. Hãy dùng nút Tải về.', 'warn');
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  const scalePctX = imgNaturalSize.width > 0 ? (crop.x / imgNaturalSize.width) * 100 : 0;
  const scalePctY = imgNaturalSize.height > 0 ? (crop.y / imgNaturalSize.height) * 100 : 0;
  const scalePctW = imgNaturalSize.width > 0 ? (crop.width / imgNaturalSize.width) * 100 : 0;
  const scalePctH = imgNaturalSize.height > 0 ? (crop.height / imgNaturalSize.height) * 100 : 0;

  const isCurrentPresetSaved = Boolean(localSavedCrops[activePreset]);

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center overflow-hidden bg-black/85 p-0 backdrop-blur-md animate-fadeIn select-none sm:p-6">
      {/* ── Modal Window Container ── */}
      <div className="relative flex h-[100dvh] max-h-none w-full max-w-[1240px] flex-col overflow-hidden rounded-none border border-white/10 bg-[#0E131F] text-slate-100 shadow-2xl selection:bg-blue-600 selection:text-white sm:h-[92vh] sm:max-h-[900px] sm:rounded-2xl">
        {/* ── Top Bar ── */}
        <div className="flex min-h-14 flex-none items-center justify-between gap-2 border-b border-white/[0.08] bg-slate-900/80 px-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 grid place-items-center">
              <Crop className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-[14.5px] font-bold text-white flex items-center gap-2">
                <span>Cắt ảnh AI & Thủ công</span>
                <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300 border border-blue-500/20">
                  {activePreset}
                </span>
                {isCurrentPresetSaved && (
                  <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                    <BookmarkCheck className="w-3 h-3" />
                    <span>Đã lưu vị trí team</span>
                  </span>
                )}
              </h2>
              <p className="hidden text-[11px] text-slate-400 sm:block">
                AI đề xuất khung tâm điểm · Con người trực tiếp kéo thả và lưu lại cho cả team
              </p>
            </div>
          </div>

          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              onClick={handleAiAutoCenter}
              className="flex min-h-11 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 text-[12px] font-semibold text-amber-300 shadow-xs transition-all hover:bg-amber-500/20"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">AI Auto-Center</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng công cụ crop"
              className="ml-1 grid min-h-11 min-w-11 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Main Workspace Body (2 Columns) ── */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          {/* ── Left: Interactive Canvas Viewport ── */}
          <div className="relative flex min-h-[42dvh] min-w-0 flex-1 flex-col overflow-hidden bg-[#070A10] md:min-h-0">
            {/* Top Ratio Preset Toolbar */}
            <div className="flex flex-none items-center gap-2 overflow-x-auto border-b border-white/[0.06] bg-slate-900/40 p-2 sm:p-3">
              <span className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider px-2">
                Tỷ lệ:
              </span>
              {CROP_PRESETS.map((preset) => {
                const isActive = activePreset === preset.id;
                const isSaved = Boolean(localSavedCrops[preset.id]);

                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => handlePresetChange(preset.id)}
                    className={cn(
                      'relative flex min-h-11 flex-none items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold transition-all',
                      isActive
                        ? 'bg-blue-600 text-white shadow-sm shadow-blue-500/30'
                        : 'bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] hover:text-white border border-white/[0.06]'
                    )}
                  >
                    <span>{preset.label}</span>
                    {isSaved && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" title="Đã lưu vị trí cho team" />
                    )}
                    <span className="text-[10px] opacity-75 font-normal">({preset.description.split('(')[0].trim()})</span>
                  </button>
                );
              })}
            </div>

            {/* Canvas Interactive Center Container */}
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 select-none touch-none sm:p-6"
              style={{
                backgroundImage: `linear-gradient(45deg, #121724 25%, transparent 25%), linear-gradient(-45deg, #121724 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #121724 75%), linear-gradient(-45deg, transparent 75%, #121724 75%)`,
                backgroundSize: '20px 20px',
                backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
              }}
            >
              {/* Image & Crop Layer Wrapper */}
              <div
                className="relative inline-block max-w-full max-h-full transition-transform duration-150 shadow-2xl select-none"
                style={{ transform: `rotate(${rotation}deg)` }}
              >
                <img
                  ref={imageRef}
                  src={imageUrl}
                  alt="Crop source"
                  crossOrigin="anonymous"
                  onLoad={handleImageLoad}
                  className="block max-h-[calc(42dvh-110px)] max-w-full rounded-lg object-contain pointer-events-none select-none sm:max-h-[calc(92vh-220px)]"
                  draggable={false}
                />

                {imageLoaded && (
                  <>
                    {/* Semi-transparent Dark Scrim Overlay */}
                    <div
                      className="absolute inset-0 bg-black/60 pointer-events-none rounded-lg"
                      style={{
                        clipPath: `polygon(
                          0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
                          ${scalePctX}% ${scalePctY}%,
                          ${scalePctX}% ${scalePctY + scalePctH}%,
                          ${scalePctX + scalePctW}% ${scalePctY + scalePctH}%,
                          ${scalePctX + scalePctW}% ${scalePctY}%,
                          ${scalePctX}% ${scalePctY}%
                        )`,
                      }}
                    />

                    {/* Interactive Draggable & Resizable Crop Frame */}
                    <div
                      className="absolute border-2 border-blue-500 cursor-move shadow-[0_0_0_1px_rgba(255,255,255,0.4)] touch-none select-none"
                      style={{
                        left: `${scalePctX}%`,
                        top: `${scalePctY}%`,
                        width: `${scalePctW}%`,
                        height: `${scalePctH}%`,
                        borderRadius: isRounded ? `${borderRadius}px` : '0px',
                      }}
                      onPointerDown={(e) => handlePointerDown('move', e)}
                    >
                      {/* Rule of Thirds Grid Lines */}
                      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3 pointer-events-none border border-white/20">
                        <div className="border-r border-b border-white/20" />
                        <div className="border-r border-b border-white/20" />
                        <div className="border-b border-white/20" />
                        <div className="border-r border-b border-white/20" />
                        <div className="border-r border-b border-white/20" />
                        <div className="border-b border-white/20" />
                        <div className="border-r border-white/20" />
                        <div className="border-r border-white/20" />
                        <div />
                      </div>

                      {/* Center Crosshair */}
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none flex items-center justify-center opacity-70">
                        <div className="w-full h-0.5 bg-blue-400" />
                        <div className="h-full w-0.5 bg-blue-400 absolute" />
                      </div>

                      {/* 8 Resize Handles */}
                      <div
                        onPointerDown={(e) => handlePointerDown('nw', e)}
                        className="absolute -top-2 -left-2 w-4 h-4 bg-blue-500 border-2 border-white rounded-xs cursor-nwse-resize shadow-md hover:scale-125 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('ne', e)}
                        className="absolute -top-2 -right-2 w-4 h-4 bg-blue-500 border-2 border-white rounded-xs cursor-nesw-resize shadow-md hover:scale-125 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('se', e)}
                        className="absolute -bottom-2 -right-2 w-4 h-4 bg-blue-500 border-2 border-white rounded-xs cursor-nwse-resize shadow-md hover:scale-125 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('sw', e)}
                        className="absolute -bottom-2 -left-2 w-4 h-4 bg-blue-500 border-2 border-white rounded-xs cursor-nesw-resize shadow-md hover:scale-125 transition-transform"
                      />

                      <div
                        onPointerDown={(e) => handlePointerDown('n', e)}
                        className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-5 h-2.5 bg-blue-500 border border-white rounded-xs cursor-ns-resize shadow-sm hover:scale-110 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('s', e)}
                        className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-5 h-2.5 bg-blue-500 border border-white rounded-xs cursor-ns-resize shadow-sm hover:scale-110 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('w', e)}
                        className="absolute top-1/2 -left-1.5 -translate-y-1/2 w-2.5 h-5 bg-blue-500 border border-white rounded-xs cursor-ew-resize shadow-sm hover:scale-110 transition-transform"
                      />
                      <div
                        onPointerDown={(e) => handlePointerDown('e', e)}
                        className="absolute top-1/2 -right-1.5 -translate-y-1/2 w-2.5 h-5 bg-blue-500 border border-white rounded-xs cursor-ew-resize shadow-sm hover:scale-110 transition-transform"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Bottom Status bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-slate-900/60 border-t border-white/[0.06] text-[11.5px] text-slate-400">
              <div className="flex items-center gap-4">
                <span>Ảnh gốc: <strong className="text-white font-mono">{imgNaturalSize.width} × {imgNaturalSize.height} px</strong></span>
                <span>Vùng cắt: <strong className="text-blue-400 font-mono">{crop.width} × {crop.height} px</strong></span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-400">Kéo thả khung để di chuyển · Kéo 8 chấm góc/cạnh để thu phóng</span>
              </div>
            </div>
          </div>

          {/* ── Right: Live Previews & Numeric Coordinates ── */}
          <div className="flex max-h-[58dvh] w-full flex-none flex-col space-y-4 overflow-y-auto border-t border-white/[0.08] bg-slate-900/70 p-3 md:max-h-none md:w-[340px] md:border-l md:border-t-0 md:p-5">
            {/* Live Multi-Size Preview Thumbnails */}
            <div className="space-y-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-blue-400" />
                <span>Xem trước kết quả (Live Preview)</span>
              </span>

              <div className="flex items-end gap-2.5 p-3 rounded-xl border border-white/[0.08] bg-black/30 min-h-[140px] justify-center">
                {/* Large Preview */}
                <div
                  className="w-[100px] rounded-lg overflow-hidden border border-white/20 relative shadow-sm"
                  style={{
                    height: crop.width > 0 ? `${Math.min(130, Math.round((100 * crop.height) / crop.width))}px` : '100px',
                    borderRadius: isRounded ? `${Math.round(borderRadius / 2)}px` : '6px',
                  }}
                >
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundImage: `url(${imageUrl})`,
                      backgroundPosition: `-${(crop.x / (imgNaturalSize.width || 1)) * (100 * (imgNaturalSize.width / (crop.width || 1)))}px -${(crop.y / (imgNaturalSize.height || 1)) * ((100 * (crop.height / (crop.width || 1))) * (imgNaturalSize.height / (crop.height || 1)))}px`,
                      backgroundSize: `${(imgNaturalSize.width / (crop.width || 1)) * 100}px ${(imgNaturalSize.height / (crop.height || 1)) * (100 * (crop.height / (crop.width || 1)))}px`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  />
                </div>

                {/* Medium Preview */}
                <div
                  className="w-[55px] rounded-md overflow-hidden border border-white/20 relative opacity-80"
                  style={{
                    height: crop.width > 0 ? `${Math.min(75, Math.round((55 * crop.height) / crop.width))}px` : '55px',
                    borderRadius: isRounded ? `${Math.round(borderRadius / 4)}px` : '4px',
                  }}
                >
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundImage: `url(${imageUrl})`,
                      backgroundPosition: `-${(crop.x / (imgNaturalSize.width || 1)) * (55 * (imgNaturalSize.width / (crop.width || 1)))}px -${(crop.y / (imgNaturalSize.height || 1)) * ((55 * (crop.height / (crop.width || 1))) * (imgNaturalSize.height / (crop.height || 1)))}px`,
                      backgroundSize: `${(imgNaturalSize.width / (crop.width || 1)) * 55}px ${(imgNaturalSize.height / (crop.height || 1)) * (55 * (crop.height / (crop.width || 1)))}px`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  />
                </div>

                {/* Small Thumbnail Preview */}
                <div
                  className="w-[32px] rounded-sm overflow-hidden border border-white/20 relative opacity-60"
                  style={{
                    height: crop.width > 0 ? `${Math.min(45, Math.round((32 * crop.height) / crop.width))}px` : '32px',
                  }}
                >
                  <div
                    className="w-full h-full"
                    style={{
                      backgroundImage: `url(${imageUrl})`,
                      backgroundPosition: `-${(crop.x / (imgNaturalSize.width || 1)) * (32 * (imgNaturalSize.width / (crop.width || 1)))}px -${(crop.y / (imgNaturalSize.height || 1)) * ((32 * (crop.height / (crop.width || 1))) * (imgNaturalSize.height / (crop.height || 1)))}px`,
                      backgroundSize: `${(imgNaturalSize.width / (crop.width || 1)) * 32}px ${(imgNaturalSize.height / (crop.height || 1)) * (32 * (crop.height / (crop.width || 1)))}px`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Numeric Coordinates Inputs */}
            <div className="space-y-2.5">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Thông số tọa độ & Kích thước
              </span>

              <div className="grid grid-cols-2 gap-2 text-[12.5px]">
                {/* X Coordinate */}
                <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
                  <span className="px-2.5 py-1.5 text-slate-400 font-mono font-semibold bg-white/[0.04] border-r border-white/10">X</span>
                  <input
                    type="number"
                    value={crop.x}
                    onChange={(e) => handleCoordinateChange('x', Number(e.target.value))}
                    className="min-h-11 w-full bg-transparent px-2 py-1.5 text-right font-mono text-white focus:outline-none"
                  />
                  <span className="pr-2 text-slate-500 font-mono text-[11px]">px</span>
                </div>

                {/* Y Coordinate */}
                <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
                  <span className="px-2.5 py-1.5 text-slate-400 font-mono font-semibold bg-white/[0.04] border-r border-white/10">Y</span>
                  <input
                    type="number"
                    value={crop.y}
                    onChange={(e) => handleCoordinateChange('y', Number(e.target.value))}
                    className="min-h-11 w-full bg-transparent px-2 py-1.5 text-right font-mono text-white focus:outline-none"
                  />
                  <span className="pr-2 text-slate-500 font-mono text-[11px]">px</span>
                </div>

                {/* Width */}
                <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
                  <span className="px-2.5 py-1.5 text-slate-400 font-mono font-semibold bg-white/[0.04] border-r border-white/10">W</span>
                  <input
                    type="number"
                    value={crop.width}
                    onChange={(e) => handleCoordinateChange('width', Number(e.target.value))}
                    className="min-h-11 w-full bg-transparent px-2 py-1.5 text-right font-mono text-white focus:outline-none"
                  />
                  <span className="pr-2 text-slate-500 font-mono text-[11px]">px</span>
                </div>

                {/* Height */}
                <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.04] overflow-hidden focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500">
                  <span className="px-2.5 py-1.5 text-slate-400 font-mono font-semibold bg-white/[0.04] border-r border-white/10">H</span>
                  <input
                    type="number"
                    value={crop.height}
                    onChange={(e) => handleCoordinateChange('height', Number(e.target.value))}
                    className="min-h-11 w-full bg-transparent px-2 py-1.5 text-right font-mono text-white focus:outline-none"
                  />
                  <span className="pr-2 text-slate-500 font-mono text-[11px]">px</span>
                </div>
              </div>

              {/* Rotate & Rounded Corners Controls */}
              <div className="space-y-2 pt-2 border-t border-white/[0.06]">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] text-slate-300">Góc xoay</span>
                  <button
                    type="button"
                    onClick={handleRotate}
                    className="flex min-h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-[12px] font-mono text-slate-200 transition-colors hover:bg-white/[0.1]"
                  >
                    <RotateCw className="w-3.5 h-3.5 text-blue-400" />
                    <span>{rotation}°</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleReset}
                  className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-[12px] font-semibold text-slate-300 transition-colors hover:bg-white/[0.1] hover:text-white"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span>Đặt lại khung & xoay</span>
                </button>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-[12px] text-slate-300">Bo tròn góc</span>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isRounded}
                      onChange={(e) => setIsRounded(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>

                {isRounded && (
                  <div className="pt-1 space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-400">
                      <span>Bán kính bo</span>
                      <span className="font-mono">{borderRadius}px</span>
                    </div>
                    <input
                      type="range"
                      min="4"
                      max="100"
                      value={borderRadius}
                      onChange={(e) => setBorderRadius(Number(e.target.value))}
                      className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* ── Action Buttons ── */}
            <div className="mt-auto pt-3 border-t border-white/[0.08] space-y-2">
              {/* Primary Save Configuration Button */}
              <button
                type="button"
                onClick={() => void handleSaveCropConfig()}
                disabled={isSaving || imgNaturalSize.width === 0}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 text-[13px] font-bold text-white shadow-lg shadow-emerald-600/25 transition-all hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                <span>Lưu vị trí Crop này (Để team dùng lại)</span>
              </button>

              {/* Download Cropped PNG */}
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={isExporting || imgNaturalSize.width === 0}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-[12.5px] font-semibold text-white shadow-md shadow-blue-600/20 transition-all hover:bg-blue-500 active:scale-[0.98] disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Tải ảnh đã cắt (PNG)</span>
              </button>

              {/* Copy to Clipboard */}
              <button
                type="button"
                onClick={() => void handleCopyClipboard()}
                disabled={isExporting || imgNaturalSize.width === 0}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] text-[12px] font-medium text-slate-200 transition-all hover:bg-white/[0.08] active:scale-[0.98] disabled:opacity-50"
              >
                <Copy className="w-3.5 h-3.5 text-slate-400" />
                <span>Copy vào Clipboard</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
