'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** [I-1] Namespace prefix tránh key collision trong localStorage (theo quy ước ai-vision.ts). */
const STORAGE_KEY = 'verity-media:review-inspector-width';

export const DEFAULT_INSPECTOR_WIDTH = 420;
export const MIN_INSPECTOR_WIDTH = 340;
export const MAX_INSPECTOR_WIDTH = 640;

/** Trần thực tế không bao giờ vượt quá 50% chiều rộng viewport, để Inspector không nuốt hết khung ảnh. */
function effectiveMaxWidth(): number {
  if (typeof window === 'undefined') return MAX_INSPECTOR_WIDTH;
  return Math.min(MAX_INSPECTOR_WIDTH, Math.floor(window.innerWidth * 0.5));
}

function clampWidth(width: number, maxWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_INSPECTOR_WIDTH;
  return Math.round(Math.min(maxWidth, Math.max(MIN_INSPECTOR_WIDTH, width)));
}

/**
 * Đọc độ rộng đã lưu từ localStorage.
 * [C-1] Guard: chỉ chạy phía browser, trả về default khi SSR.
 */
function loadInspectorWidth(maxWidth: number): number {
  if (typeof window === 'undefined') return DEFAULT_INSPECTOR_WIDTH;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_INSPECTOR_WIDTH;
    const parsed = Number(raw);
    return clampWidth(parsed, maxWidth);
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

/**
 * Lưu độ rộng vào localStorage.
 * [C-1] Guard: bỏ qua nếu storage bị block (private mode, quota exceeded, v.v.)
 */
function saveInspectorWidth(width: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Bỏ qua nếu storage bị block.
  }
}

export interface UseResizableInspectorWidthReturn {
  width: number;
  setWidth: (next: number) => void;
  resetWidth: () => void;
  minWidth: number;
  maxWidth: number;
}

/**
 * Độ rộng cột Inspector (MetadataForm/BatchReviewForm) ở Focus View desktop, có thể
 * kéo giãn và được ghi nhớ giữa các lần tải trang. Đọc localStorage sau mount (không
 * đọc lúc render đầu) để tránh lệch hydration -- giống pattern isCompactReview đã có
 * trong ReviewView.tsx.
 */
export function useResizableInspectorWidth(): UseResizableInspectorWidthReturn {
  const [maxWidth, setMaxWidth] = useState(MAX_INSPECTOR_WIDTH);
  const [width, setWidthState] = useState(DEFAULT_INSPECTOR_WIDTH);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    const nextMax = effectiveMaxWidth();
    setMaxWidth(nextMax);
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true;
      setWidthState(loadInspectorWidth(nextMax));
    }
  }, []);

  useEffect(() => {
    function handleResize() {
      const nextMax = effectiveMaxWidth();
      setMaxWidth(nextMax);
      setWidthState((current) => clampWidth(current, nextMax));
    }
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const setWidth = useCallback((next: number) => {
    setWidthState((current) => {
      const clamped = clampWidth(next, effectiveMaxWidth());
      if (clamped === current) return current;
      saveInspectorWidth(clamped);
      return clamped;
    });
  }, []);

  const resetWidth = useCallback(() => {
    setWidthState(() => {
      saveInspectorWidth(DEFAULT_INSPECTOR_WIDTH);
      return DEFAULT_INSPECTOR_WIDTH;
    });
  }, []);

  return { width, setWidth, resetWidth, minWidth: MIN_INSPECTOR_WIDTH, maxWidth };
}
