'use client';

import React, { useState } from 'react';
import {
  Sparkles,
  Building2,
  Home,
  Cpu,
  CheckCircle2,
  Layers,
  RotateCcw,
  Wand2,
  Globe,
  Lock,
  Wrench,
  Package,
  Camera,
  Tag,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUploadContextConfig } from '@/hooks/useUploadContextConfig';

interface BatchContextSelectorProps {
  context: string;
  onChange: (context: string) => void;
  permission?: 'public' | 'internal';
  onPermissionChange?: (permission: 'public' | 'internal') => void;
  className?: string;
}

export const MAX_BATCH_CONTEXT_LENGTH = 500;

const TAG_GROUP_ICON_REGISTRY: Record<string, React.ComponentType<{ className?: string }>> = {
  Building2,
  Home,
  Cpu,
  CheckCircle2,
  Wrench,
  Package,
  Camera,
  Tag,
  Layers,
};

export function BatchContextSelector({
  context,
  onChange,
  permission = 'public',
  onPermissionChange,
  className,
}: BatchContextSelectorProps) {
  const { config } = useUploadContextConfig();
  const { quickPresets, tagGroups } = config;
  const [isTagCloudOpen, setIsTagCloudOpen] = useState(false);

  const isTagActive = (tagText: string) => {
    return context.toLowerCase().includes(tagText.toLowerCase());
  };

  const toggleTag = (tagText: string) => {
    const trimmed = context.trim();
    if (!trimmed) {
      onChange(tagText);
      return;
    }

    if (isTagActive(tagText)) {
      const escaped = tagText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|,\\s*)${escaped}(,\\s*|$)`, 'gi');
      const updated = trimmed
        .replace(regex, (match, p1, p2) => (p1 && p2 ? ', ' : ''))
        .replace(/^,\s*|,\s*$/g, '')
        .trim();
      onChange(updated);
    } else {
      const next = `${trimmed}, ${tagText}`;
      onChange(next.slice(0, MAX_BATCH_CONTEXT_LENGTH));
    }
  };

  const applyPreset = (presetValue: string) => {
    onChange(presetValue);
  };

  // Tính số lượng tag đang được kích hoạt trong context
  const activeTagsCount = tagGroups
    .flatMap((group) => group.tags)
    .filter((tag) => isTagActive(tag)).length;

  const totalTagsCount = tagGroups.reduce((acc, g) => acc + g.tags.length, 0);

  return (
    <div
      className={cn(
        'p-4 sm:p-5 rounded-2xl border border-border bg-surface shadow-xs space-y-3.5 select-none transition-all',
        className
      )}
    >
      {/* ── Section Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-verity" />
          <span className="text-[13.5px] font-bold text-text-1">
            Ngữ cảnh cho AI
          </span>
          <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-semibold text-text-3 border border-border/60">
            Tùy chọn
          </span>
        </div>

        {context && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="flex items-center gap-1 text-[11.5px] font-semibold text-text-3 transition-colors hover:text-bad cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Xóa</span>
          </button>
        )}
      </div>

      {/* ── Textarea Input ── */}
      <div className="relative">
        <textarea
          value={context}
          onChange={(e) => onChange(e.target.value.slice(0, MAX_BATCH_CONTEXT_LENGTH))}
          maxLength={MAX_BATCH_CONTEXT_LENGTH}
          rows={2}
          placeholder="VD: Bình giữ nhiệt LocknLock LHC4131 — chụp studio phông trắng, góc cận nắp và thân bình..."
          className="w-full resize-none rounded-xl border border-border bg-surface-2/50 p-2.5 sm:p-3 text-[13px] text-text-1 placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-verity/30 focus:border-verity transition-all shadow-2xs leading-relaxed"
        />
        <div className="absolute right-2.5 bottom-2 text-[10px] font-mono text-text-3 select-none">
          {context.length}/{MAX_BATCH_CONTEXT_LENGTH}
        </div>
      </div>

      {/* ── Quick Presets & Permission Row ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-0.5">
        {/* Quick 1-Click Presets */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[11px] font-bold text-text-3 flex items-center gap-1 mr-0.5">
            <Wand2 className="w-3 h-3 text-verity" />
            <span>Mẫu nhanh:</span>
          </span>
          {quickPresets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset.value)}
              className="flex items-center gap-1 rounded-lg border border-border/80 bg-surface-2/70 px-2 py-1 text-[11px] font-medium text-text-1 shadow-2xs transition-all hover:border-verity/40 hover:bg-surface-2 active:scale-[0.98] cursor-pointer"
              title={`Áp dụng: "${preset.value}"`}
            >
              <span className="text-xs">{preset.icon}</span>
              <span>{preset.label}</span>
            </button>
          ))}
        </div>

        {/* Permission Switcher */}
        {onPermissionChange && (
          <div className="inline-flex items-center p-0.5 rounded-lg bg-surface-2 border border-border/80 flex-none self-start sm:self-auto shadow-2xs">
            <button
              type="button"
              onClick={() => onPermissionChange('public')}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all cursor-pointer',
                permission === 'public'
                  ? 'bg-ok-soft text-ok font-bold shadow-xs border border-ok-border/80'
                  : 'text-text-3 hover:text-text-1'
              )}
              title="Công khai trong thư viện, sẵn sàng cho Marketing & Web"
            >
              <Globe className="w-3 h-3" />
              <span>Công khai</span>
            </button>
            <button
              type="button"
              onClick={() => onPermissionChange('internal')}
              className={cn(
                'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-all cursor-pointer',
                permission === 'internal'
                  ? 'bg-surface text-text-1 font-bold shadow-xs border border-border'
                  : 'text-text-3 hover:text-text-1'
              )}
              title="Chỉ lưu hành nội bộ Verity"
            >
              <Lock className="w-3 h-3" />
              <span>Nội bộ</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Progressive Disclosure: Collapsible Detailed Tag Cloud ── */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setIsTagCloudOpen((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-xl border border-dashed border-border/80 bg-surface-2/30 px-3 py-2 text-[11.5px] font-medium text-text-2 transition-all hover:bg-surface-2/80 hover:border-border-strong hover:text-text-1 cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            <Tag className="w-3.5 h-3.5 text-verity" />
            <span>Gợi ý từ khóa & tag chi tiết</span>
            {activeTagsCount > 0 && (
              <span className="rounded-full bg-verity/15 px-1.5 py-0.2 text-[10px] font-bold text-verity">
                {activeTagsCount} đã chọn
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 text-[10.5px] text-text-3">
            <span>{isTagCloudOpen ? 'Thu gọn' : `Mở rộng (${totalTagsCount} tag)`}</span>
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 transition-transform duration-200 text-text-3',
                isTagCloudOpen && 'rotate-180 text-verity'
              )}
            />
          </div>
        </button>

        {isTagCloudOpen && (
          <div className="mt-2.5 space-y-2.5 rounded-xl border border-border/70 bg-surface-2/20 p-3 animate-fadeIn">
            {tagGroups.map((group) => {
              const GroupIcon = TAG_GROUP_ICON_REGISTRY[group.icon] ?? Layers;
              return (
                <div key={group.name} className="flex items-start gap-2 flex-wrap sm:flex-nowrap">
                  <div className="flex items-center gap-1 text-[11px] font-bold text-text-3 w-[100px] flex-none pt-0.5">
                    <GroupIcon className="w-3 h-3 text-text-disabled" />
                    <span>{group.name}:</span>
                  </div>
                  <div className="flex items-center flex-wrap gap-1 flex-1">
                    {group.tags.map((tag) => {
                      const active = isTagActive(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleTag(tag)}
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-[11px] font-medium transition-all cursor-pointer select-none active:scale-[0.98]',
                            active
                              ? 'bg-verity text-white border-verity font-bold shadow-2xs'
                              : 'bg-surface hover:bg-surface-2 text-text-2 hover:text-text-1 border-border/80 hover:border-border-strong'
                          )}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
