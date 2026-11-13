import React from 'react';
import { cn } from '@/lib/utils';

export type BadgeVariant =
  | 'verity'
  | 'ok'
  | 'warn'
  | 'bad'
  | 'ai'
  | 'teal'
  | 'mute'
  | 'gold'
  | 'private'
  | 'solid';

interface VerityBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: 'sm' | 'md' | 'lg';
  onPhoto?: boolean;
  dot?: boolean;
  children: React.ReactNode;
}

export function VerityBadge({
  variant = 'verity',
  size = 'md',
  onPhoto = false,
  dot = false,
  className,
  children,
  ...props
}: VerityBadgeProps) {
  const variantStyles: Record<BadgeVariant, string> = {
    verity: 'bg-verity-soft text-verity-fg border-verity-border',
    ok: 'bg-ok-soft text-ok border-ok-border',
    warn: 'bg-warn-soft text-warn border-warn-border',
    bad: 'bg-bad-soft text-bad border-bad-border',
    ai: 'bg-ai-soft text-ai border-ai-border',
    teal: 'bg-teal-soft text-teal border-teal-border',
    mute: 'bg-mute-soft text-mute border-mute-border',
    gold: 'bg-gold-soft text-gold-on-soft border-gold-border font-bold',
    private: 'bg-surface-2 dark:bg-[#3A4A5A] text-text-1 dark:text-white border-border-strong font-semibold',
    solid: 'bg-verity text-white border-transparent',
  };

  const onPhotoStyles: Record<BadgeVariant, string> = {
    verity: 'bg-[rgba(16,76,135,0.85)] text-white border-white/20',
    ok: 'bg-[rgba(26,127,69,0.85)] text-white border-white/20',
    warn: 'bg-[rgba(180,101,15,0.88)] text-white border-white/20',
    bad: 'bg-[rgba(179,38,30,0.88)] text-white border-white/20',
    ai: 'bg-[rgba(109,69,196,0.88)] text-white border-white/20',
    teal: 'bg-[rgba(15,123,108,0.85)] text-white border-white/20',
    mute: 'bg-[rgba(70,89,107,0.85)] text-white border-white/20',
    gold: 'bg-gold text-gold-ink border-transparent font-bold',
    private: 'bg-[rgba(40,54,68,0.92)] text-white border-white/20',
    solid: 'bg-verity text-white border-transparent',
  };

  const sizeStyles = {
    sm: 'h-[18px] px-1.5 text-[10.5px]',
    md: 'h-[20px] px-[7px] text-[11.5px]',
    lg: 'h-[24px] px-2 text-[12px]',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 flex-none rounded-[6px] font-semibold tracking-[-0.005em] whitespace-nowrap border transition-colors',
        onPhoto
          ? cn('backdrop-blur-[6px] shadow-sm', onPhotoStyles[variant])
          : variantStyles[variant],
        sizeStyles[size],
        className
      )}
      {...props}
    >
      {dot && (
        <span
          className="w-1.5 h-1.5 rounded-full bg-currentColor flex-none"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
