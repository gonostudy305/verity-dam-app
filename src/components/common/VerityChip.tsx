import React from 'react';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

interface VerityChipProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  onRemove?: () => void;
  variant?: 'filter' | 'query';
  children: React.ReactNode;
}

export function VerityChip({
  active = false,
  onRemove,
  variant = 'filter',
  className,
  children,
  ...props
}: VerityChipProps) {
  if (variant === 'query') {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-1.5 h-[26px] pl-3 pr-1 rounded-full',
          'bg-verity-soft border border-verity-border text-verity-fg text-[12px] font-medium',
          className
        )}
      >
        <span>{children}</span>
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="w-4 h-4 rounded-full grid place-items-center text-verity-fg/70 hover:text-verity-fg hover:bg-verity-soft-hi transition-colors"
            title="Ẩn gợi ý này"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded-lg border text-[12.5px] font-medium transition-all select-none',
        active
          ? 'bg-verity text-white border-verity font-semibold shadow-sm'
          : 'bg-surface border-border text-text-2 hover:border-border-strong hover:text-text-1 hover:bg-surface-2',
        className
      )}
      {...props}
    >
      <span>{children}</span>
    </button>
  );
}
