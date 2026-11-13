'use client';

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldCheck, ShieldAlert, Sparkles, SlidersHorizontal, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaAsset } from '@/types/media';
import type { TaxonomyItem } from '@/config/taxonomy';

interface AdvancedMetaAccordionProps {
  permission: MediaAsset['permission'];
  onPermissionChange: (perm: MediaAsset['permission']) => void;
  source: string;
  suggestedCaption: string | undefined;
  onCaptionChange: (caption: string) => void;
  visibleText?: string[];
  keywordsInput: string;
  onKeywordsChange: (kw: string) => void;
  permissions: TaxonomyItem[];
  hasPeople?: boolean;
  internalLabel?: string;
  peopleLabel?: string;
  editedFields: Record<string, boolean>;
  disabled?: boolean;
  className?: string;
}

export function AdvancedMetaAccordion({
  permission = 'public',
  onPermissionChange,
  source,
  suggestedCaption = '',
  onCaptionChange,
  visibleText = [],
  keywordsInput,
  onKeywordsChange,
  permissions,
  hasPeople = false,
  internalLabel = 'Chỉ nội bộ',
  peopleLabel = 'Có người',
  editedFields,
  disabled = false,
  className,
}: AdvancedMetaAccordionProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Summary badges for collapsed state
  const isPublic = permission === 'public';
  const hasCaption = Boolean(suggestedCaption && suggestedCaption.trim().length > 0);

  return (
    <div className={cn('rounded-xl border border-border/80 bg-surface-2/40 overflow-hidden transition-all', className)}>
      {/* Accordion Trigger */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-surface-2/80 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-3.5 h-3.5 text-text-3 flex-none" />
          <span className="text-[12px] font-bold text-text-2">
            Thông tin mở rộng & Caption
          </span>
          {!isOpen && (
            <span className="text-[11px] text-text-3 truncate font-medium">
              ({isPublic ? 'Public' : 'Nội bộ'}{hasCaption ? ' · Có Caption' : ''})
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-none text-text-3">
          <span className="text-[11px] font-medium">{isOpen ? 'Thu gọn' : 'Mở rộng'}</span>
          {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </div>
      </button>

      {/* Accordion Body */}
      {isOpen && (
        <div className="p-3.5 pt-1 space-y-3.5 border-t border-border/60 animate-fadeIn">
          {/* Row 1: Permission full-width + has_people toggle */}
          <div className="flex items-center gap-2">
            {/* Permission selector — now takes most of the width */}
            <div className="flex-1 space-y-1">
              <label className="text-[11.5px] font-bold text-text-2">Quyền dùng</label>
              <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-surface border border-border">
                {permissions.map((p) => {
                  const isPub = p.value === 'public';
                  const isSelected = permission === p.value;
                  const Icon = isPub ? ShieldCheck : ShieldAlert;

                  return (
                    <button
                      key={p.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => onPermissionChange(p.value as MediaAsset['permission'])}
                      className={cn(
                        'h-[30px] rounded-md text-[11px] font-semibold transition-all flex items-center justify-center gap-1 cursor-pointer',
                        isSelected
                          ? isPub
                            ? 'bg-ok-soft text-ok border border-ok/30 shadow-xs'
                            : 'bg-warn-soft text-warn border border-warn/30 shadow-xs'
                          : 'text-text-3 hover:text-text-1'
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      <span>{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* has_people indicator — prominent when AI detected people */}
            <div className="space-y-1 flex-none">
              <label className="text-[11.5px] font-bold text-text-2 block">Người</label>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  permission !== 'internal' && onPermissionChange('internal')
                }
                title={hasPeople ? `AI phát hiện ${peopleLabel} — nên đổi sang "${internalLabel}"` : 'Không có người trong ảnh'}
                className={cn(
                  'h-[30px] px-2.5 rounded-md border text-[11px] font-semibold flex items-center gap-1 transition-all',
                  hasPeople
                    ? 'bg-warn-soft border-warn/40 text-warn cursor-pointer hover:bg-warn/20'
                    : 'bg-surface border-border text-text-3 cursor-default opacity-60'
                )}
              >
                <span>{hasPeople ? '👤' : '—'}</span>
                <span>{hasPeople ? peopleLabel : 'Không'}</span>
              </button>
            </div>
          </div>

          {/* Safety hint below when people detected */}
          {hasPeople && permission === 'public' && (
            <p className="text-[11px] font-medium text-warn flex items-center gap-1 -mt-1.5">
              <span>⚠️ {peopleLabel} → nên chuyển sang "{internalLabel}" rồi nhấn nút bên trên</span>
            </p>
          )}

          {/* Row 2: Caption Field */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11.5px] font-bold text-text-2 flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-verity" />
                <span>Caption đề xuất (AI)</span>
              </label>
              {editedFields.suggested_caption && (
                <span className="text-[10px] font-semibold text-learn animate-fadeIn">đã ghi nhận</span>
              )}
            </div>

            <div className="p-2 rounded-lg border border-border bg-surface focus-within:border-verity focus-within:ring-2 focus-within:ring-verity/20">
              <textarea
                rows={2}
                disabled={disabled}
                value={suggestedCaption}
                onChange={(e) => onCaptionChange(e.target.value)}
                placeholder="Nhập mô tả / caption cho hình ảnh..."
                className="w-full bg-transparent border-0 outline-none text-[12px] text-text-1 resize-none leading-relaxed"
              />
            </div>

            {/* OCR Tokens Inspector */}
            {visibleText.length > 0 && (
              <div className="space-y-1 p-2 rounded-lg bg-surface-2/60 border border-border-subtle">
                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] font-bold text-text-3">🔍 Chữ AI đọc trên ảnh (OCR):</span>
                  <span className="text-[9.5px] text-text-3 font-mono">click để chèn vào caption</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {visibleText.map((text, idx) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        const current = suggestedCaption?.trim() || '';
                        onCaptionChange(current ? `${current} · ${text}` : text);
                      }}
                      className="px-1.5 py-0.5 rounded text-[10.5px] bg-surface hover:bg-surface-3 border border-border text-text-2 hover:text-text-1 cursor-pointer transition-all"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Row 3: Keywords & Source */}
          <div className="grid grid-cols-3 gap-2 pt-0.5">
            <div className="col-span-2 space-y-1">
              <label className="text-[11px] font-bold text-text-3">Từ khóa (cách nhau bằng dấu phẩy)</label>
              <input
                type="text"
                disabled={disabled}
                value={keywordsInput}
                onChange={(e) => onKeywordsChange(e.target.value)}
                placeholder="khóa thông minh, cửa nhôm..."
                className="w-full px-2.5 h-8 rounded-lg border border-border bg-surface text-[11.5px] text-text-1 outline-none focus:border-verity"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-bold text-text-3">Nguồn</label>
              <div className="flex items-center justify-between h-8 px-2.5 rounded-lg bg-surface border border-border text-[11.5px] text-text-2 font-mono">
                <span className="truncate">{source || 'upload'}</span>
                <span className="text-[9px] text-text-3">auto</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
