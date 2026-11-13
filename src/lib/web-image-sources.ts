/**
 * web-image-sources.ts
 * Quản lý cấu hình nguồn ảnh từ Web (Stock miễn phí thương mại & Search Engine)
 * Lưu trữ an toàn trong localStorage (phía client)
 */

import type { WebImageSourceConfig } from '@/types/media';

const STORAGE_KEY = 'verity-media:web-image-sources';

export const DEFAULT_WEB_IMAGE_CONFIG: WebImageSourceConfig = {
  unsplash: {
    enabled: false,
    accessKey: '',
  },
  pexels: {
    enabled: false,
    apiKey: '',
  },
  pixabay: {
    enabled: false,
    apiKey: '',
  },
  googleCse: {
    enabled: false,
    apiKey: '',
    cx: '',
    onlyCreativeCommons: true,
  },
  braveSearch: {
    enabled: false,
    subscriptionToken: '',
  },
  duckDuckGo: {
    enabled: true, // Mặc định bật làm fallback miễn phí không cần key
  },
};

/**
 * Lưu cấu hình Web Image Sources vào localStorage
 */
export function saveWebImageConfig(config: WebImageSourceConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write errors
  }
}

/**
 * Đọc cấu hình Web Image Sources từ localStorage
 */
export function loadWebImageConfig(): WebImageSourceConfig {
  if (typeof window === 'undefined') return DEFAULT_WEB_IMAGE_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WEB_IMAGE_CONFIG;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_WEB_IMAGE_CONFIG,
      ...parsed,
      unsplash: { ...DEFAULT_WEB_IMAGE_CONFIG.unsplash, ...parsed.unsplash },
      pexels: { ...DEFAULT_WEB_IMAGE_CONFIG.pexels, ...parsed.pexels },
      pixabay: { ...DEFAULT_WEB_IMAGE_CONFIG.pixabay, ...parsed.pixabay },
      googleCse: { ...DEFAULT_WEB_IMAGE_CONFIG.googleCse, ...parsed.googleCse },
      braveSearch: { ...DEFAULT_WEB_IMAGE_CONFIG.braveSearch, ...parsed.braveSearch },
      duckDuckGo: { ...DEFAULT_WEB_IMAGE_CONFIG.duckDuckGo, ...parsed.duckDuckGo },
    };
  } catch {
    return DEFAULT_WEB_IMAGE_CONFIG;
  }
}

/**
 * Đếm số lượng provider Stock đang có API key hoặc được kích hoạt
 */
export function getStockActiveCount(config: WebImageSourceConfig): { active: number; total: number } {
  let active = 0;
  if (config.unsplash.accessKey.trim().length > 0) active++;
  if (config.pexels.apiKey.trim().length > 0) active++;
  if (config.pixabay.apiKey.trim().length > 0) active++;
  return { active, total: 3 };
}

/**
 * Đếm số lượng provider Search Engine đang có API key hoặc được kích hoạt
 */
export function getSearchActiveCount(config: WebImageSourceConfig): { active: number; total: number } {
  let active = 0;
  if (config.googleCse.apiKey.trim().length > 0 && config.googleCse.cx.trim().length > 0) active++;
  if (config.braveSearch.subscriptionToken.trim().length > 0) active++;
  if (config.duckDuckGo.enabled) active++;
  return { active, total: 3 };
}
