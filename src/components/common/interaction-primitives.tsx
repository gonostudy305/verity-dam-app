'use client';

import React, { forwardRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Tabs from '@radix-ui/react-tabs';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ResponsiveDialogSheetProps {
  trigger?: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: 'sheet' | 'dialog';
  className?: string;
  contentClassName?: string;
}

export function ResponsiveDialogSheet({
  trigger,
  title,
  description,
  children,
  open,
  defaultOpen,
  onOpenChange,
  variant = 'sheet',
  className,
  contentClassName,
}: ResponsiveDialogSheetProps) {
  return (
    <Dialog.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-overlay)] bg-black/50 backdrop-blur-[1px] data-[state=open]:animate-overlay-in" />
        <Dialog.Content
          data-variant={variant}
          className={cn(
            'responsive-dialog-content fixed z-[var(--z-modal)] border border-border bg-surface text-text-1 shadow-pop outline-none',
            variant === 'sheet'
              ? 'inset-x-0 bottom-0 max-h-[min(86dvh,720px)] overscroll-contain overflow-y-auto rounded-t-2xl p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:left-1/2 md:right-auto md:top-1/2 md:bottom-auto md:w-[min(calc(100vw-2rem),34rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:p-5'
              : 'left-1/2 top-1/2 max-h-[min(86dvh,720px)] w-[min(calc(100vw-2rem),34rem)] -translate-x-1/2 -translate-y-1/2 overscroll-contain overflow-y-auto rounded-2xl p-5 pb-[calc(1rem+env(safe-area-inset-bottom))]',
            className
          )}
        >
          <div className="flex items-start gap-3 pr-11">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-bold tracking-tight text-text-1">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-[12.5px] leading-relaxed text-text-2">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
          </div>
          <Dialog.Close
            aria-label="Đóng"
            className="absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-xl text-text-3 transition-colors hover:bg-hover hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
          <div className={cn('mt-4', contentClassName)}>{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ResponsiveDialogClose({ children }: { children: React.ReactElement }) {
  return <Dialog.Close asChild>{children}</Dialog.Close>;
}

export interface AccessibleTabItem {
  value: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

interface AccessibleTabsProps {
  tabs: readonly AccessibleTabItem[];
  children: React.ReactNode;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  ariaLabel: string;
  className?: string;
  listClassName?: string;
  size?: 'sm' | 'md';
}

export function AccessibleTabs({
  tabs,
  children,
  defaultValue,
  value,
  onValueChange,
  ariaLabel,
  className,
  listClassName,
  size = 'md',
}: AccessibleTabsProps) {
  const isSm = size === 'sm';

  return (
    <Tabs.Root
      className={className}
      defaultValue={defaultValue}
      value={value}
      onValueChange={onValueChange}
    >
      <Tabs.List
        aria-label={ariaLabel}
        className={cn(
          isSm
            ? 'flex h-8 min-h-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5'
            : 'flex min-h-11 items-center gap-1 rounded-xl bg-surface-2 p-1',
          listClassName
        )}
      >
        {tabs.map((tab) => (
          <Tabs.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              'inline-flex flex-1 items-center justify-center whitespace-nowrap transition-colors hover:bg-surface hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-verity data-[state=active]:bg-surface data-[state=active]:text-verity cursor-pointer',
              isSm
                ? 'h-7 min-h-0 gap-1 rounded-md px-2.5 text-[11.5px] font-semibold text-text-2 data-[state=active]:shadow-xs'
                : 'min-h-11 gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold text-text-2 data-[state=active]:shadow-sm'
            )}
          >
            {tab.icon}
            <span className="whitespace-nowrap">{tab.label}</span>
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {children}
    </Tabs.Root>
  );
}

export function AccessibleTabPanel({
  value,
  children,
  className,
}: {
  value: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Tabs.Content forceMount value={value} className={cn('outline-none focus-visible:ring-2 focus-visible:ring-verity', className)}>
      {children}
    </Tabs.Content>
  );
}

interface OverflowMenuProps {
  trigger: React.ReactElement;
  children: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
}

export function OverflowMenu({
  trigger,
  children,
  align = 'end',
  sideOffset = 8,
  className,
}: OverflowMenuProps) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={sideOffset}
          collisionPadding={12}
          className={cn('z-[var(--z-popover)] w-[min(15rem,calc(100vw-1.5rem))] rounded-xl border border-border bg-surface p-1.5 text-text-1 shadow-pop outline-none data-[state=open]:animate-pop', className)}
        >
          {children}
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function OverflowMenuItem({
  children,
  onSelect,
  destructive = false,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  destructive?: boolean;
}) {
  return (
    <Popover.Close asChild>
      <button
        type="button"
        onClick={onSelect}
        className={cn('flex min-h-11 w-full items-center rounded-lg px-3 text-left text-[12.5px] font-medium transition-colors hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-verity', destructive ? 'text-bad hover:bg-bad-soft' : 'text-text-2 hover:text-text-1')}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

export const TouchIconButton = forwardRef<HTMLButtonElement, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & { label: string }>(
  function TouchIconButton({ label, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cn('inline-grid h-11 w-11 flex-none place-items-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-verity disabled:cursor-not-allowed disabled:opacity-50', className)}
        {...props}
      />
    );
  }
);

export function ActionBar({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div role={label ? 'toolbar' : undefined} aria-label={label} className={cn('flex items-center gap-2', className)}>
      {children}
    </div>
  );
}

export function TouchCheckmark({ className }: { className?: string }) {
  return <Check aria-hidden="true" className={cn('h-4 w-4', className)} />;
}

export function DisclosureIcon({ open }: { open: boolean }) {
  return <ChevronDown aria-hidden="true" className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />;
}
