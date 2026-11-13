import React from 'react';
import { MediaAsset } from '@/types/media';
import { VerityBadge } from '@/components/common/VerityBadge';
import { cn } from '@/lib/utils';
import { Eye } from 'lucide-react';
import { formatSimilarity } from './DuplicateCompareModal';

interface DuplicateBannerProps {
  similarity?: number;
  matches?: MediaAsset[];
  currentAsset?: MediaAsset;
  onOpenCompare?: (matchIndex: number) => void;
  className?: string;
}

export function DuplicateBanner({
  similarity = 0.92,
  matches = [],
  onOpenCompare,
  className,
}: DuplicateBannerProps) {
  const formattedSim = formatSimilarity(similarity);

  return (
    <div
      className={cn(
        'p-3.5 mb-4 rounded-2xl border border-amber-500/40 bg-amber-500/10 flex flex-col gap-2.5 animate-pop',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <VerityBadge variant="gold" size="sm">
            Trùng lặp
          </VerityBadge>
          <span className="text-[13px] font-bold text-text-1">
            Giống {formattedSim} với ảnh đã có trong kho
          </span>
        </div>
      </div>

      {/* Matched thumbnails + Action trigger button */}
      <div className="flex items-center justify-between gap-3 pt-1 border-t border-amber-500/20">
        <div className="flex items-center gap-2 min-w-0">
          {matches.map((m, idx) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onOpenCompare?.(idx)}
              className="group relative w-[54px] h-[40px] rounded-lg overflow-hidden border border-amber-500/40 shadow-xs flex-none bg-black/5 hover:border-amber-500 hover:ring-2 hover:ring-amber-500/40 transition-all cursor-pointer"
              title={`Ảnh #${idx + 1} (${m.sku || 'Không có SKU'}) — Bấm để mở đối chiếu`}
            >
              <img
                src={m.thumbnail_url || m.file_url}
                alt={m.title || 'Ảnh trong kho'}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 flex items-center justify-center transition-colors">
                <Eye className="w-3.5 h-3.5 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-md" />
              </div>
            </button>
          ))}
          <span className="text-[11px] text-text-3 truncate">
            {matches.length > 1 ? `Có ${matches.length} ảnh tương đồng` : '(Bấm để đối chiếu)'}
          </span>
        </div>

        {onOpenCompare && (
          <button
            type="button"
            onClick={() => onOpenCompare(0)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-amber-700 dark:text-amber-300 text-[12px] font-bold transition-all shadow-xs flex-none cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>So sánh & Xử lý</span>
          </button>
        )}
      </div>
    </div>
  );
}

