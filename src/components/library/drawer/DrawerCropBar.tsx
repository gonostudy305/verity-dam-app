'use client';

import React from 'react';
import { Square, Smartphone, Monitor, Download, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CropConfig, MediaAsset } from '@/types/media';

interface DrawerCropBarProps {
  asset: MediaAsset;
  localCropConfigs: Record<string, CropConfig>;
  onOpenCropper: (presetId: string) => void;
  onQuickExportCrop: (presetId: '1:1' | '9:16' | '16:9') => void;
  isExporting?: boolean;
  className?: string;
}

const PRESETS = [
  { id: '1:1' as const, ratio: '1:1', label: '1:1 Vuông', Icon: Square, desc: 'Feed / Post' },
  { id: '9:16' as const, ratio: '9:16', label: '9:16 Dọc', Icon: Smartphone, desc: 'Story / TikTok' },
  { id: '16:9' as const, ratio: '16:9', label: '16:9 Ngang', Icon: Monitor, desc: 'Banner / Web' },
] as const;

export function DrawerCropBar({
  localCropConfigs,
  onOpenCropper,
  onQuickExportCrop,
  isExporting = false,
  className,
}: DrawerCropBarProps) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border/80 bg-surface-2/30 p-3 space-y-2.5 transition-all',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Sparkles className="w-3.5 h-3.5 text-amber-500 flex-none" />
          <span className="text-[12px] font-bold text-text-2 tracking-tight truncate">
            Cắt ảnh nhanh (Quick Crop & Tải)
          </span>
        </div>
        <span className="text-[10px] text-text-3 font-medium">Tối ưu chuẩn WebP</span>
      </div>

      {/* Ratio Buttons Grid */}
      <div className="grid grid-cols-3 gap-2">
        {PRESETS.map(({ id, ratio, Icon, desc }) => {
          const isConfigured = Boolean(localCropConfigs[id]);

          return (
            <div
              key={id}
              className={cn(
                'group relative flex items-center justify-between p-2 rounded-xl border bg-surface transition-all hover:border-verity hover:shadow-xs cursor-pointer',
                isConfigured ? 'border-verity/40 bg-verity/5' : 'border-border'
              )}
              onClick={() => onOpenCropper(id)}
              title={`Nhấp để căn chỉnh tỷ lệ ${ratio} (${desc})`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className={cn(
                    'w-7 h-7 rounded-lg grid place-items-center flex-none transition-colors',
                    isConfigured ? 'bg-verity text-white' : 'bg-surface-2 text-text-3 group-hover:text-text-1'
                  )}
                >
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="min-w-0">
                  <div className="text-[11.5px] font-bold text-text-1 leading-tight truncate">
                    {ratio}
                  </div>
                  <div className="text-[10px] text-text-3 truncate font-medium">
                    {desc}
                  </div>
                </div>
              </div>

              {/* Quick Download on Hover Button */}
              <button
                type="button"
                disabled={isExporting}
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickExportCrop(id);
                }}
                className="w-6 h-6 rounded-md hover:bg-surface-3 text-text-3 hover:text-verity grid place-items-center opacity-70 hover:opacity-100 transition-all flex-none"
                title={`Tải ngay ảnh cắt tỷ lệ ${ratio}`}
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
