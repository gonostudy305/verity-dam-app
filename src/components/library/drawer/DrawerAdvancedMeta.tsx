'use client';

import React, { useState } from 'react';
import { Shield, ChevronDown, ChevronUp, Code, History, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaAsset, UsageRecord } from '@/types/media';
import { useToast } from '@/components/common/Toast';
import { safeJsonLd } from '@/lib/image-object';

interface DrawerAdvancedMetaProps {
  asset: MediaAsset;
  className?: string;
}

export function DrawerAdvancedMeta({ asset, className }: DrawerAdvancedMetaProps) {
  const { showToast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);

  const hasCopyright = Boolean(asset.author || asset.copyright || asset.credit);
  const usages: UsageRecord[] = asset.usages || [];
  const hasUsage = usages.length > 0;

  const handleCopySchema = async () => {
    try {
      const jsonStr = safeJsonLd(asset);
      await navigator.clipboard.writeText(jsonStr);
      setCopiedSchema(true);
      showToast('Đã sao chép Schema JSON-LD vào bộ nhớ tạm!', 'success');
      setTimeout(() => setCopiedSchema(false), 2000);
    } catch {
      showToast('Không thể sao chép Schema.', 'warn');
    }
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/80 bg-surface-2/30 overflow-hidden transition-all',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-3.5 text-left hover:bg-surface-2/60 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Shield className="w-3.5 h-3.5 text-text-3 flex-none" />
          <span className="text-[12px] font-bold text-text-2 tracking-tight truncate">
            Nâng cao: SEO, Bản quyền & Lịch sử
          </span>
          {hasCopyright && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium flex-none">
              Đã gán bản quyền
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 text-text-3 flex-none">
          {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {isOpen && (
        <div className="p-3.5 pt-0 space-y-3.5 border-t border-border/50 text-[12px] animate-fadeIn">
          {/* Copyright Information */}
          <div className="space-y-1.5 pt-3">
            <span className="text-[11px] font-bold uppercase tracking-wider text-text-3">
              Thông tin Sở hữu Trí tuệ
            </span>
            <div className="grid grid-cols-2 gap-2 text-[11.5px]">
              <div className="p-2 rounded-xl bg-surface border border-border/60">
                <span className="text-text-3 text-[10.5px] block">Tác giả (Author)</span>
                <span className="font-medium text-text-1">{asset.author || 'VerityDAM Platform'}</span>
              </div>
              <div className="p-2 rounded-xl bg-surface border border-border/60">
                <span className="text-text-3 text-[10.5px] block">Bản quyền (Copyright)</span>
                <span className="font-medium text-text-1">{asset.copyright || '© VerityDAM Platform'}</span>
              </div>
            </div>
            {asset.credit && (
              <div className="p-2 rounded-xl bg-surface border border-border/60 text-[11.5px]">
                <span className="text-text-3 text-[10.5px] block">Ghi công (Credit)</span>
                <span className="font-medium text-text-1">{asset.credit}</span>
              </div>
            )}
          </div>

          {/* Schema JSON-LD */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1">
                <Code className="w-3 h-3" />
                <span>SEO Schema (JSON-LD)</span>
              </span>
              <button
                type="button"
                onClick={handleCopySchema}
                className="text-[11px] text-verity hover:underline font-semibold flex items-center gap-1 cursor-pointer"
              >
                {copiedSchema ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedSchema ? 'Đã chép' : 'Copy Schema'}</span>
              </button>
            </div>
            <pre className="p-2.5 rounded-xl bg-surface border border-border/60 font-mono text-[10.5px] text-text-2 overflow-x-auto max-h-[140px] select-all">
              {safeJsonLd(asset)}
            </pre>
          </div>

          {/* Usage History */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-text-3 flex items-center gap-1">
              <History className="w-3 h-3" />
              <span>Lịch sử sử dụng</span>
            </span>
            {hasUsage ? (
              <div className="space-y-1">
                {usages.map((entry: UsageRecord, i: number) => (
                  <div key={entry.id || i} className="p-2 rounded-xl bg-surface border border-border/60 flex items-center justify-between text-[11.5px]">
                    <span className="font-medium text-text-1">{entry.channel}</span>
                    <span className="text-text-3 text-[10.5px]">{entry.date} · {entry.used_by}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-text-3 italic p-2 rounded-xl bg-surface border border-border/40">
                Chưa có dữ liệu theo dõi trên các kênh chiến dịch.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
