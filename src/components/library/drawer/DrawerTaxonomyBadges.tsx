'use client';

import React from 'react';
import {
  Layers,
  MapPin,
  Wrench,
  Image as ImageIcon,
  Shield,
  AlertTriangle,
  HardDrive,
  Calendar,
  Loader2,
  Target,
  Camera,
  Sparkles,
} from 'lucide-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import type { MediaAsset } from '@/types/media';

const INTAKE_ROLE_BADGES: Record<string, { label: string; icon: React.ReactNode }> = {
  HERO: { label: 'Ảnh chính', icon: <Target className="w-3.5 h-3.5 text-rose-500" /> },
  ANGLE: { label: 'Ảnh góc', icon: <Camera className="w-3.5 h-3.5 text-indigo-500" /> },
};

const INTAKE_CATEGORY_BADGES: Record<string, { label: string; icon: React.ReactNode }> = {
  REAL: { label: 'Ảnh thực tế', icon: <Camera className="w-3.5 h-3.5 text-teal-500" /> },
  STUDIO: { label: 'Ảnh Studio', icon: <Sparkles className="w-3.5 h-3.5 text-purple-500" /> },
  DESIGN: { label: 'Ảnh Thiết kế', icon: <Layers className="w-3.5 h-3.5 text-amber-500" /> },
};

interface DrawerTaxonomyBadgesProps {
  asset: MediaAsset;
  categoryLabel?: string;
  spaceLabel?: string;
  statusLabel?: string;
  needsPostProduction?: boolean;
  canEditPostProduction?: boolean;
  isUpdatingPostProduction?: boolean;
  onTogglePostProduction?: () => void;
  canEditPermission?: boolean;
  isUpdatingPermission?: boolean;
  onTogglePermission?: () => void;
  className?: string;
}

export function DrawerTaxonomyBadges({
  asset,
  categoryLabel,
  spaceLabel,
  statusLabel,
  needsPostProduction = false,
  canEditPostProduction = false,
  isUpdatingPostProduction = false,
  onTogglePostProduction,
  canEditPermission = false,
  isUpdatingPermission = false,
  onTogglePermission,
  className,
}: DrawerTaxonomyBadgesProps) {
  const width = asset.dimensions?.width;
  const height = asset.dimensions?.height;
  const fileSize = asset.dimensions?.size_bytes ? formatBytes(asset.dimensions.size_bytes) : null;
  const dimensionStr = width && height ? `${width} × ${height} px` : null;

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/80 bg-surface-2/30 p-3.5 space-y-3 transition-all',
        className
      )}
    >
      {/* Visual Context Badges */}
      <div className="space-y-1.5">
        <span className="text-[11px] font-bold uppercase tracking-wider text-text-3">
          Phân loại & Ngữ cảnh
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          {categoryLabel && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-border text-[12px] font-semibold text-text-1 shadow-2xs">
              <Layers className="w-3.5 h-3.5 text-verity" />
              <span>{categoryLabel}</span>
            </span>
          )}

          {spaceLabel && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-border text-[12px] font-medium text-text-2 shadow-2xs">
              <MapPin className="w-3.5 h-3.5 text-blue-500" />
              <span>{spaceLabel}</span>
            </span>
          )}

          {statusLabel && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-border text-[12px] font-medium text-text-2 shadow-2xs">
              <Wrench className="w-3.5 h-3.5 text-emerald-500" />
              <span>{statusLabel}</span>
            </span>
          )}

          {/* Product Intake Confirmed Role (HERO / ANGLE) */}
          {asset.intake_confirmed_role && INTAKE_ROLE_BADGES[asset.intake_confirmed_role] && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-border text-[12px] font-semibold text-text-1 shadow-2xs"
              title={`Vai trò sản phẩm đã duyệt: ${INTAKE_ROLE_BADGES[asset.intake_confirmed_role].label}`}
            >
              {INTAKE_ROLE_BADGES[asset.intake_confirmed_role].icon}
              <span>{INTAKE_ROLE_BADGES[asset.intake_confirmed_role].label}</span>
            </span>
          )}

          {/* Product Intake Confirmed Category (REAL / STUDIO / DESIGN) */}
          {asset.intake_confirmed_image_category && INTAKE_CATEGORY_BADGES[asset.intake_confirmed_image_category] && (
            <span
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface border border-border text-[12px] font-medium text-text-2 shadow-2xs"
              title={`Loại ảnh hồ sơ: ${INTAKE_CATEGORY_BADGES[asset.intake_confirmed_image_category].label}`}
            >
              {INTAKE_CATEGORY_BADGES[asset.intake_confirmed_image_category].icon}
              <span>{INTAKE_CATEGORY_BADGES[asset.intake_confirmed_image_category].label}</span>
            </span>
          )}

          {/* Post-Production Badge (Interactive for Reviewer/Admin, Read-only for Viewer) */}
          {canEditPostProduction ? (
            <button
              type="button"
              onClick={onTogglePostProduction}
              disabled={isUpdatingPostProduction}
              title={
                needsPostProduction
                  ? 'Ảnh đang đánh dấu Cần hậu kỳ (Nhấp để hủy, hoặc bấm phím H)'
                  : 'Đánh dấu ảnh cần hậu kỳ (Nhấp để bật, hoặc bấm phím H)'
              }
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-all cursor-pointer shadow-2xs select-none',
                needsPostProduction
                  ? 'bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25'
                  : 'bg-surface border border-dashed border-border text-text-3 hover:text-text-1 hover:border-text-3'
              )}
            >
              {isUpdatingPostProduction ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
              ) : (
                <Wrench
                  className={cn(
                    'w-3.5 h-3.5',
                    needsPostProduction ? 'text-amber-500' : 'text-text-3'
                  )}
                />
              )}
              <span>{needsPostProduction ? 'Cần hậu kỳ' : '+ Hậu kỳ'}</span>
            </button>
          ) : needsPostProduction ? (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-[12px] font-semibold text-amber-700 dark:text-amber-300 shadow-2xs">
              <Wrench className="w-3.5 h-3.5 text-amber-500" />
              <span>Cần hậu kỳ</span>
            </span>
          ) : null}

          {!categoryLabel && !spaceLabel && !statusLabel && !asset.intake_confirmed_role && !asset.intake_confirmed_image_category && !needsPostProduction && !canEditPostProduction && (
            <span className="text-[12px] text-text-3 italic">Chưa phân loại ngữ cảnh</span>
          )}
        </div>
      </div>

      {/* Technical Specs & Governance Badges */}
      <div className="pt-2.5 border-t border-border/50 flex flex-wrap items-center gap-2 text-[11.5px] text-text-2">
        {asset.created_at && (
          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-border/70 font-mono text-[11px] text-text-2"
            title={`Ngày upload: ${formatDate(asset.created_at)}`}
          >
            <Calendar className="w-3 h-3 text-text-3" />
            <span>{formatDate(asset.created_at)}</span>
          </span>
        )}

        {dimensionStr && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-border/70 font-mono text-[11px] text-text-2">
            <ImageIcon className="w-3 h-3 text-text-3" />
            <span>{dimensionStr}</span>
            {fileSize && <span>· {fileSize}</span>}
          </span>
        )}

        {asset.permission && (
          canEditPermission ? (
            <button
              type="button"
              onClick={onTogglePermission}
              disabled={isUpdatingPermission}
              title={
                asset.permission === 'internal'
                  ? 'Ảnh đang đặt quyền Nội bộ. Nhấp để chuyển sang Công khai'
                  : 'Ảnh đang đặt quyền Công khai. Nhấp để chuyển sang Nội bộ'
              }
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium transition-all cursor-pointer shadow-2xs select-none',
                asset.permission === 'internal'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20'
              )}
            >
              {isUpdatingPermission ? (
                <Loader2 className="w-3 h-3 animate-spin text-current" />
              ) : (
                <Shield className="w-3 h-3" />
              )}
              <span>{asset.permission === 'internal' ? 'Nội bộ' : 'Công khai'}</span>
              <span className="text-[9px] opacity-60">⇄</span>
            </button>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium',
                asset.permission === 'internal'
                  ? 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-300'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
              )}
            >
              <Shield className="w-3 h-3" />
              <span>{asset.permission === 'internal' ? 'Nội bộ' : 'Công khai'}</span>
            </span>
          )
        )}

        {asset.ai_flags?.has_people && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/30 text-[11px] font-medium text-rose-700 dark:text-rose-300">
            <AlertTriangle className="w-3 h-3 text-rose-500" />
            <span>Có người</span>
          </span>
        )}

        {asset.origin_info?.source && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface border border-border/70 text-[11px] text-text-3">
            <HardDrive className="w-3 h-3" />
            <span>Nguồn: {asset.origin_info.source}</span>
          </span>
        )}
      </div>
    </div>
  );
}
