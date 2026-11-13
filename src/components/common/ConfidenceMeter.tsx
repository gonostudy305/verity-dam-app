import React from 'react';
import { cn } from '@/lib/utils';

interface ConfidenceMeterProps {
  value: number; // 0 - 100
  showLabel?: boolean;
  className?: string;
}

export function ConfidenceMeter({
  value,
  showLabel = true,
  className,
}: ConfidenceMeterProps) {
  // Normalize 0.0 - 1.0 float to 0 - 100 percentage
  const normalized = typeof value === 'number'
    ? value > 0 && value <= 1
      ? Math.round(value * 100)
      : Math.round(value)
    : 0;

  const isHigh = normalized >= 85;

  return (
    <div className={cn('flex items-center gap-1.5 flex-none select-none', className)}>
      {showLabel && (
        <span
          className={cn(
            'font-mono text-[10px] font-bold tracking-tight',
            isHigh ? 'text-ok' : 'text-warn'
          )}
        >
          {normalized}%
        </span>
      )}
      <div className="w-[46px] h-[4px] rounded-full bg-surface-inset overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-300', isHigh ? 'bg-ok' : 'bg-warn')}
          style={{ width: `${Math.max(4, Math.min(100, normalized))}%` }}
        />
      </div>
    </div>
  );
}
