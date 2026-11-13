'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Check, AlertCircle, Info, X } from 'lucide-react';

interface Toast {
  id: string;
  message: string;
  type?: 'success' | 'warn' | 'info';
}

interface ToastContextType {
  showToast: (message: string, type?: 'success' | 'warn' | 'info') => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setIsOpen(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const handleDismiss = useCallback(() => {
    setIsOpen(false);
    setTimeout(() => {
      onDismiss(toast.id);
    }, 220);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    const timer = setTimeout(handleDismiss, 2800);
    return () => clearTimeout(timer);
  }, [handleDismiss]);

  return (
    <div
      role="status"
      className={cn(
        't-toast pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl shadow-pop border text-[13px] font-semibold',
        isOpen ? 'is-open' : 'is-closing',
        toast.type === 'success' && 'bg-surface text-text-1 border-border-strong',
        toast.type === 'warn' && 'bg-surface text-warn border-warn-border',
        toast.type === 'info' && 'bg-verity text-white border-transparent'
      )}
    >
      {toast.type === 'success' && <Check className="w-4 h-4 text-ok flex-none" />}
      {toast.type === 'warn' && <AlertCircle className="w-4 h-4 text-warn flex-none" />}
      {toast.type === 'info' && <Info className="w-4 h-4 text-white flex-none" />}
      <span>{toast.message}</span>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Đóng thông báo"
        className="ml-1 p-0.5 rounded-md opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10 transition-opacity cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((message: string, type: 'success' | 'warn' | 'info' = 'success') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed bottom-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom)+0.75rem)] left-3 right-3 z-[var(--z-modal)] flex -translate-x-0 flex-col items-center gap-2 pointer-events-none md:bottom-6 md:left-1/2 md:right-auto md:-translate-x-1/2"
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
