import { useState, useCallback } from 'react';
import type { MediaAsset, CropConfig } from '@/types/media';
import { injectImageMetadata } from '@/lib/client/image-metadata';

export type ExportFormat = 'webp' | 'jpg' | 'png';

export interface ImageExportOptions {
  asset: MediaAsset;
  cropConfigs?: Record<string, CropConfig>;
}

/**
 * Removes Vietnamese diacritics/accents from a string, converting them to plain ASCII.
 * Handles decomposed and precomposed Unicode, including 'đ' and 'Đ'.
 */
export function removeVietnameseAccents(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (m) => (m === 'đ' ? 'd' : 'D'));
}

/**
 * Sanitizes input text intended for a Windows/cross-platform filename while editing.
 * Removes Vietnamese diacritics and forbidden Windows characters: \ / : * ? " < > |
 */
export function sanitizeFilenameInput(val: string): string {
  if (!val) return '';
  const noAccents = removeVietnameseAccents(val);
  return noAccents.replace(/[\\/:*?"<>|]/g, '');
}

/**
 * Sanitizes a filename to ensure it is completely safe across Windows, macOS, and Linux filesystems.
 * Strips reserved characters: \ / : * ? " < > |
 * Normalizes Vietnamese diacritics to plain ASCII.
 * Normalizes multiple hyphens, spaces, and trims leading/trailing hyphens.
 */
export function sanitizeWindowsFilename(name: string, fallbackExt?: string): string {
  if (!name || typeof name !== 'string') return `asset.${(fallbackExt || 'webp').replace(/^\./, '')}`;

  const trimmed = name.trim();
  const lastDot = trimmed.lastIndexOf('.');
  let base = trimmed;
  let ext = (fallbackExt || '').replace(/^\./, '');

  if (lastDot > 0 && lastDot < trimmed.length - 1) {
    const candidateExt = trimmed.slice(lastDot + 1).toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'svg'].includes(candidateExt)) {
      base = trimmed.slice(0, lastDot);
      ext = candidateExt;
    }
  }

  const unaccentedBase = removeVietnameseAccents(base);
  let cleanBase = unaccentedBase
    .replace(/[\s/\\?%*:|"<>]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();

  if (!cleanBase) cleanBase = 'asset';

  const cleanExt = (ext || fallbackExt || 'webp').replace(/^\./, '').toLowerCase();
  return `${cleanBase}.${cleanExt}`;
}

export function buildSmartFilename(
  asset: MediaAsset,
  suffix: string,
  extension: string
): string {
  const cleanExt = extension.replace(/^\./, '');
  const sanitize = (str?: string | null) =>
    removeVietnameseAccents(str || '')
      .trim()
      .replace(/[\s/\\?%*:|"<>]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

  if (asset.canonical_slug && (suffix === 'original' || suffix === 'web')) {
    const cleanSlug = sanitize(asset.canonical_slug);
    if (cleanSlug) {
      return `${cleanSlug}.${cleanExt}`;
    }
  }

  const parts = [
    'VERITY',
    sanitize(asset.sku) || sanitize(asset.id?.slice(0, 8)),
    sanitize(asset.brand),
    sanitize(suffix),
  ].filter(Boolean);

  return `${parts.join('_')}.${cleanExt}`;
}

export function getCorsSafeUrl(url: string): string {
  if (!url || !url.startsWith('http') || /[?&]cors=1\b/.test(url)) return url;
  // Append cors=1 cache-buster so browser HTTP cache never reuses a cached
  // no-cors response (from plain <img> tags) when doing CORS canvas/blob fetches
  return url.includes('?') ? `${url}&cors=1` : `${url}?cors=1`;
}

/**
 * Derives a Same-Origin /api/r2-proxy fallback URL from any storage-backed URL
 * (e.g. cdn.example.com, r2.dev, or external CDN).
 * Ensures canvas image operations (Copy ảnh, Crop) remain 100% resilient even
 * if direct CDN CORS is blocked by browser cache or edge headers.
 */
export function getProxyFallbackUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('/api/r2-proxy')) return null;

  try {
    const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
    const parsed = new URL(url, base);
    if (parsed.pathname.startsWith('/api/r2-proxy')) return null;

    const pathname = parsed.pathname.replace(/^\/+/, '');
    if (
      pathname.startsWith('wp-content/') ||
      pathname.startsWith('u/') ||
      pathname.startsWith('original/')
    ) {
      return `/api/r2-proxy?key=${encodeURIComponent(pathname)}`;
    }
  } catch {
    // Ignore invalid URL parse
  }
  return null;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const safeUrl = getCorsSafeUrl(url);

  // Helper to load an HTMLImageElement safely from a local Blob (never taints canvas)
  const loadFromBlob = (blob: Blob): Promise<HTMLImageElement> => {
    const blobUrl = URL.createObjectURL(blob);
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(blobUrl);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(blobUrl);
        reject(new Error('Lỗi giải mã dữ liệu ảnh'));
      };
      img.src = blobUrl;
    });
  };

  // 1. Try fetch blob first (handles same-origin credentials, bypasses browser CORS image-cache quirks)
  try {
    const res = await fetch(safeUrl, { mode: 'cors' });
    if (res.ok) {
      const blob = await res.blob();
      return await loadFromBlob(blob);
    }
  } catch {
    // If direct fetch fails (e.g. cross-origin restrictions without CORS), try fallback
  }

  // 2. Same-Origin Proxy Fallback (Defense-in-depth: immune to cross-origin CORS policy)
  const proxyUrl = getProxyFallbackUrl(url);
  if (proxyUrl) {
    try {
      const res = await fetch(proxyUrl);
      if (res.ok) {
        const blob = await res.blob();
        return await loadFromBlob(blob);
      }
    } catch {
      // Proxy fallback failed, proceed to direct Image element
    }
  }

  // 3. Direct Image element fallback with crossOrigin
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error('Không thể tải dữ liệu ảnh từ máy chủ. Hãy kiểm tra kết nối mạng.'));
    img.src = safeUrl;
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const cleanFilename = sanitizeWindowsFilename(filename);
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = cleanFilename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
}

export function useImageExport() {
  const [isExporting, setIsExporting] = useState(false);
  const [exportingType, setExportingType] = useState<string | null>(null);

  // 0. Tải ảnh theo định dạng được chọn (WebP, JPG, PNG)
  const exportFormatted = useCallback(
    async (
      asset: MediaAsset,
      format: ExportFormat,
      customFilename?: string
    ): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType(format);
      try {
        const filename = customFilename
          ? sanitizeWindowsFilename(customFilename, format)
          : buildSmartFilename(asset, 'original', format);

        // Case 1: WebP (Định dạng gốc của Verity DAM, siêu nhẹ, giữ nguyên độ nét)
        if (format === 'webp') {
          if (asset.file_url.toLowerCase().includes('.webp')) {
            try {
              const fetchUrl = getCorsSafeUrl(asset.file_url);
              const response = await fetch(fetchUrl, { mode: 'cors' });
              if (response.ok) {
                let blob = await response.blob();
                blob = await injectImageMetadata(blob, asset, 'webp');
                triggerDownload(blob, filename);
                return {
                  success: true,
                  message: `Đã tải ảnh WebP (${Math.round(blob.size / 1024)} KB)`,
                };
              }
            } catch {
              const r2Key = asset.cdn_key || (asset as { storage_path?: string }).storage_path;
              if (r2Key) {
                try {
                  const proxyUrl = `/api/r2-proxy?key=${encodeURIComponent(r2Key)}`;
                  const proxyRes = await fetch(proxyUrl);
                  if (proxyRes.ok) {
                    let blob = await proxyRes.blob();
                    blob = await injectImageMetadata(blob, asset, 'webp');
                    triggerDownload(blob, filename);
                    return {
                      success: true,
                      message: `Đã tải ảnh WebP (${Math.round(blob.size / 1024)} KB)`,
                    };
                  }
                } catch {
                  // Fallback to canvas conversion
                }
              }
            }
          }

          const img = await loadImage(asset.file_url);
          const w = img.naturalWidth || 1200;
          const h = img.naturalHeight || 800;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');
          ctx.drawImage(img, 0, 0, w, h);

          return new Promise((resolve) => {
            canvas.toBlob(
              async (blob) => {
                if (!blob) {
                  resolve({ success: false, message: 'Lỗi nén ảnh WebP' });
                  return;
                }
                const enriched = await injectImageMetadata(blob, asset, 'webp');
                triggerDownload(enriched, filename);
                resolve({
                  success: true,
                  message: `Đã tải ảnh WebP (${w}×${h} · ~${Math.round(enriched.size / 1024)} KB)`,
                });
              },
              'image/webp',
              0.90
            );
          });
        }

        // Case 2: JPG (Tương thích cao: Zalo, Word, Photoshop cũ)
        if (format === 'jpg') {
          const img = await loadImage(asset.file_url);
          const w = img.naturalWidth || 1200;
          const h = img.naturalHeight || 800;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

          // Đổ nền trắng cho JPEG để tránh vùng trong suốt biến thành màu đen
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          return new Promise((resolve) => {
            canvas.toBlob(
              async (blob) => {
                if (!blob) {
                  resolve({ success: false, message: 'Lỗi nén ảnh JPG' });
                  return;
                }
                const enriched = await injectImageMetadata(blob, asset, 'jpg');
                triggerDownload(enriched, filename);
                resolve({
                  success: true,
                  message: `Đã tải ảnh JPG (${w}×${h} · ~${Math.round(enriched.size / 1024)} KB)`,
                });
              },
              'image/jpeg',
              0.92
            );
          });
        }

        // Case 3: PNG (Nét cao, bảo toàn kênh Alpha / trong suốt)
        if (format === 'png') {
          const img = await loadImage(asset.file_url);
          const w = img.naturalWidth || 1200;
          const h = img.naturalHeight || 800;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

          // Giữ nguyên độ trong suốt (không đổ nền trắng)
          ctx.drawImage(img, 0, 0, w, h);

          return new Promise((resolve) => {
            canvas.toBlob(
              async (blob) => {
                if (!blob) {
                  resolve({ success: false, message: 'Lỗi nén ảnh PNG' });
                  return;
                }
                const enriched = await injectImageMetadata(blob, asset, 'png');
                triggerDownload(enriched, filename);
                resolve({
                  success: true,
                  message: `Đã tải ảnh PNG (${w}×${h} · ~${Math.round(enriched.size / 1024)} KB)`,
                });
              },
              'image/png'
            );
          });
        }

        return { success: false, message: `Định dạng ${format} không được hỗ trợ` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi khi tải ảnh';
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  // 1. Tải ảnh gốc (Original)
  const exportOriginal = useCallback(
    async (asset: MediaAsset, customFilename?: string): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType('original');
      try {
        const extMatch = asset.file_url.split(/[#?]/)[0].split('.').pop();
        const ext = extMatch && extMatch.length <= 4 ? extMatch.toLowerCase() : 'jpg';
        const filename = customFilename
          ? sanitizeWindowsFilename(customFilename, ext)
          : buildSmartFilename(asset, 'original', ext);

        // Fetch blob to enforce filename across browsers
        try {
          const fetchUrl = getCorsSafeUrl(asset.file_url);
          const response = await fetch(fetchUrl, { mode: 'cors' });
          if (response.ok) {
            let blob = await response.blob();
            blob = await injectImageMetadata(blob, asset, ext as 'jpg' | 'png' | 'webp');
            triggerDownload(blob, filename);
            return { success: true, message: `Đã tải ảnh gốc: ${filename}` };
          }
        } catch {
          // If direct fetch fails (CORS), attempt via r2-proxy if storage key is available
          const r2Key = asset.cdn_key || (asset as { storage_path?: string }).storage_path;
          if (r2Key) {
            try {
              const proxyUrl = `/api/r2-proxy?key=${encodeURIComponent(r2Key)}`;
              const proxyRes = await fetch(proxyUrl);
              if (proxyRes.ok) {
                let blob = await proxyRes.blob();
                blob = await injectImageMetadata(blob, asset, ext as 'jpg' | 'png' | 'webp');
                triggerDownload(blob, filename);
                return { success: true, message: `Đã tải ảnh gốc: ${filename}` };
              }
            } catch {
              // fallback
            }
          }
        }

        const anchor = document.createElement('a');
        anchor.href = asset.file_url;
        anchor.download = filename;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        return { success: true, message: `Đã tải ảnh gốc: ${filename}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi khi tải ảnh gốc';
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  // 2. Tải ảnh nhẹ gửi Zalo / Chat (Max 1200px, JPEG 82%)
  const exportZalo = useCallback(
    async (asset: MediaAsset, customFilename?: string): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType('zalo');
      try {
        const img = await loadImage(asset.file_url);
        const naturalW = img.naturalWidth || 1200;
        const naturalH = img.naturalHeight || 800;

        const MAX_DIM = 1200;
        let targetW = naturalW;
        let targetH = naturalH;

        if (naturalW > MAX_DIM || naturalH > MAX_DIM) {
          if (naturalW >= naturalH) {
            targetW = MAX_DIM;
            targetH = Math.round((naturalH * MAX_DIM) / naturalW);
          } else {
            targetH = MAX_DIM;
            targetW = Math.round((naturalW * MAX_DIM) / naturalH);
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

        // White background for safety
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const filename = customFilename
          ? sanitizeWindowsFilename(customFilename, 'jpg')
          : buildSmartFilename(asset, 'zalo_1200px', 'jpg');

        return new Promise((resolve) => {
          canvas.toBlob(
            async (blob) => {
              if (!blob) {
                resolve({ success: false, message: 'Lỗi nén ảnh Zalo' });
                return;
              }
              const enrichedBlob = await injectImageMetadata(blob, asset, 'jpg');
              triggerDownload(enrichedBlob, filename);
              resolve({ success: true, message: `Đã tải ảnh Zalo (~${Math.round(enrichedBlob.size / 1024)} KB)` });
            },
            'image/jpeg',
            0.82
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi khi xuất ảnh Zalo';
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  // 3. Tải chuẩn Web (WebP SEO siêu nhẹ, GIỮ NGUYÊN TỶ LỆ GỐC, Max 1600px)
  const exportWebP = useCallback(
    async (asset: MediaAsset): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType('webp');
      try {
        const img = await loadImage(asset.file_url);
        const naturalW = img.naturalWidth || 1200;
        const naturalH = img.naturalHeight || 800;

        const MAX_DIM = 1600;
        let targetW = naturalW;
        let targetH = naturalH;

        if (naturalW > MAX_DIM || naturalH > MAX_DIM) {
          if (naturalW >= naturalH) {
            targetW = MAX_DIM;
            targetH = Math.round((naturalH * MAX_DIM) / naturalW);
          } else {
            targetH = MAX_DIM;
            targetW = Math.round((naturalW * MAX_DIM) / naturalH);
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

        // DO NOT fill white background! Keep transparency if source has alpha.
        ctx.drawImage(img, 0, 0, targetW, targetH);

        const filename = buildSmartFilename(asset, 'web', 'webp');

        return new Promise((resolve) => {
          canvas.toBlob(
            async (blob) => {
              if (blob) {
                const enrichedBlob = await injectImageMetadata(blob, asset, 'webp');
                triggerDownload(enrichedBlob, filename);
                resolve({
                  success: true,
                  message: `Đã tải ảnh WebP (${targetW}×${targetH} · ~${Math.round(enrichedBlob.size / 1024)} KB)`,
                });
              } else {
                canvas.toBlob(
                  async (jpgBlob) => {
                    if (!jpgBlob) {
                      resolve({ success: false, message: 'Lỗi xuất ảnh Web' });
                      return;
                    }
                    const jpgName = buildSmartFilename(asset, 'web', 'jpg');
                    const enrichedJpg = await injectImageMetadata(jpgBlob, asset, 'jpg');
                    triggerDownload(enrichedJpg, jpgName);
                    resolve({
                      success: true,
                      message: `Đã tải ảnh JPG (${targetW}×${targetH} · ~${Math.round(enrichedJpg.size / 1024)} KB)`,
                    });
                  },
                  'image/jpeg',
                  0.88
                );
              }
            },
            'image/webp',
            0.86
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi khi xuất ảnh Web';
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  // Backward compatibility alias for exportWebCatalog
  const exportWebCatalog = exportWebP;

  // 4. Tải theo tỷ lệ cắt kênh (1:1, 9:16, 16:9) với tùy chọn định dạng & giữ trong suốt
  const exportCrop = useCallback(
    async (
      asset: MediaAsset,
      presetId: '1:1' | '9:16' | '16:9',
      savedCrop?: CropConfig,
      format: 'auto' | 'jpg' | 'png' | 'webp' = 'auto'
    ): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType(`crop-${presetId}`);
      try {
        const img = await loadImage(asset.file_url);
        const naturalW = img.naturalWidth || 1200;
        const naturalH = img.naturalHeight || 800;

        let cropX = 0;
        let cropY = 0;
        let cropW = naturalW;
        let cropH = naturalH;

        if (savedCrop && savedCrop.width > 0 && savedCrop.height > 0) {
          // Clamp exact integers inside natural bounds to eliminate sub-pixel seams
          cropX = Math.max(0, Math.floor(savedCrop.x));
          cropY = Math.max(0, Math.floor(savedCrop.y));
          cropW = Math.max(1, Math.min(Math.floor(savedCrop.width), naturalW - cropX));
          cropH = Math.max(1, Math.min(Math.floor(savedCrop.height), naturalH - cropY));
        } else {
          // AI Auto-Center algorithm
          const ratioMap: Record<string, number> = {
            '1:1': 1,
            '9:16': 9 / 16,
            '16:9': 16 / 9,
          };
          const targetRatio = ratioMap[presetId] || 1;
          const imgRatio = naturalW / naturalH;

          if (imgRatio > targetRatio) {
            cropH = Math.floor(naturalH * 0.96);
            cropW = Math.floor(cropH * targetRatio);
          } else {
            cropW = Math.floor(naturalW * 0.96);
            cropH = Math.floor(cropW / targetRatio);
          }
          cropW = Math.max(1, Math.min(cropW, naturalW));
          cropH = Math.max(1, Math.min(cropH, naturalH));
          cropX = Math.max(0, Math.floor((naturalW - cropW) / 2));
          cropY = Math.max(0, Math.floor((naturalH - cropH) / 2));
        }

        const canvas = document.createElement('canvas');
        canvas.width = cropW;
        canvas.height = cropH;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

        // Detect output format
        const isPngSource = asset.file_url.toLowerCase().includes('.png') || Boolean(savedCrop?.is_rounded);
        let targetFormat = format;
        if (targetFormat === 'auto') {
          targetFormat = isPngSource ? 'png' : 'jpg';
        }

        // Only fill white background if target is JPG
        if (targetFormat === 'jpg') {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, cropW, cropH);
        }

        // Handle rounded corners if specified in crop config
        if (savedCrop?.is_rounded && savedCrop.border_radius) {
          const radius = (Math.min(cropW, cropH) * (savedCrop.border_radius / 100)) / 2;
          ctx.beginPath();
          ctx.moveTo(radius, 0);
          ctx.lineTo(cropW - radius, 0);
          ctx.quadraticCurveTo(cropW, 0, cropW, radius);
          ctx.lineTo(cropW, cropH - radius);
          ctx.quadraticCurveTo(cropW, cropH, cropW - radius, cropH);
          ctx.lineTo(radius, cropH);
          ctx.quadraticCurveTo(0, cropH, 0, cropH - radius);
          ctx.lineTo(0, radius);
          ctx.quadraticCurveTo(0, 0, radius, 0);
          ctx.closePath();
          ctx.clip();
        }

        ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

        const suffix = presetId.replace(':', 'x');
        const mimeType = targetFormat === 'png'
          ? 'image/png'
          : targetFormat === 'webp'
            ? 'image/webp'
            : 'image/jpeg';
        const ext = targetFormat === 'png' ? 'png' : targetFormat === 'webp' ? 'webp' : 'jpg';
        const filename = buildSmartFilename(asset, `crop_${suffix}`, ext);

        return new Promise((resolve) => {
          canvas.toBlob(
            async (blob) => {
              if (!blob) {
                resolve({ success: false, message: `Lỗi xuất ảnh tỷ lệ ${presetId}` });
                return;
              }
              const finalBlob = await injectImageMetadata(blob, asset, targetFormat);
              triggerDownload(finalBlob, filename);
              resolve({
                success: true,
                message: `Đã tải ảnh ${presetId} [${ext.toUpperCase()}] (${cropW}×${cropH} · ~${Math.round(finalBlob.size / 1024)} KB)`,
              });
            },
            mimeType,
            targetFormat === 'png' ? undefined : targetFormat === 'webp' ? 0.90 : 0.92
          );
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : `Lỗi khi xuất ảnh ${presetId}`;
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  // 5. Copy ảnh Bitmap vào Clipboard
  const copyImageToClipboard = useCallback(
    async (asset: MediaAsset): Promise<{ success: boolean; message: string }> => {
      setIsExporting(true);
      setExportingType('clipboard');
      try {
        if (typeof window !== 'undefined' && !window.isSecureContext) {
          return {
            success: false,
            message:
              'Tính năng Copy ảnh yêu cầu kết nối bảo mật HTTPS (https://dam.verity.internal). Vui lòng truy cập qua HTTPS hoặc dùng nút Tải ảnh.',
          };
        }

        if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
          return {
            success: false,
            message: 'Trình duyệt hiện tại không hỗ trợ sao chép ảnh trực tiếp. Vui lòng dùng nút Tải ảnh.',
          };
        }

        const pngBlobPromise = (async (): Promise<Blob> => {
          const img = await loadImage(asset.file_url);
          const naturalW = img.naturalWidth || 800;
          const naturalH = img.naturalHeight || 600;

          const canvas = document.createElement('canvas');
          canvas.width = naturalW;
          canvas.height = naturalH;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Không thể khởi tạo Canvas Context');

          ctx.drawImage(img, 0, 0, naturalW, naturalH);

          return new Promise<Blob>((resolve, reject) => {
            canvas.toBlob((blob) => {
              if (blob) resolve(blob);
              else reject(new Error('Không thể tạo dữ liệu ảnh PNG'));
            }, 'image/png');
          });
        })();

        try {
          // Standard modern API (Safari 13.1+, Chrome 86+, Firefox 127+):
          // Passing Promise<Blob> preserves the user activation gesture across async operations
          await navigator.clipboard.write([
            new ClipboardItem({
              'image/png': pngBlobPromise,
            }),
          ]);
          return {
            success: true,
            message: 'Đã sao chép ảnh vào Clipboard! Bạn có thể dán (Ctrl+V) ngay vào Zalo, Messenger, Photoshop.',
          };
        } catch (writeErr: any) {
          // Fallback for browsers requiring resolved blob before write call
          try {
            const resolvedBlob = await pngBlobPromise;
            await navigator.clipboard.write([
              new ClipboardItem({
                'image/png': resolvedBlob,
              }),
            ]);
            return {
              success: true,
              message: 'Đã sao chép ảnh vào Clipboard! Bạn có thể dán (Ctrl+V) ngay vào Zalo, Messenger, Photoshop.',
            };
          } catch (fallbackErr: any) {
            const errText = fallbackErr instanceof Error ? fallbackErr.message : (writeErr instanceof Error ? writeErr.message : '');
            return {
              success: false,
              message:
                errText.includes('NotAllowedError') || errText.includes('permission') || errText.includes('gesture')
                  ? 'Trình duyệt từ chối quyền ghi Clipboard (cần tương tác trực tiếp hoặc cấp quyền). Hãy dùng nút Tải ảnh.'
                  : `Không thể dán vào clipboard: ${errText || 'Lỗi bảo mật trình duyệt'}`,
            };
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Lỗi khi sao chép ảnh';
        return { success: false, message: msg };
      } finally {
        setIsExporting(false);
        setExportingType(null);
      }
    },
    []
  );

  return {
    isExporting,
    exportingType,
    exportFormatted,
    exportOriginal,
    exportZalo,
    exportWebP,
    exportWebCatalog,
    exportCrop,
    copyImageToClipboard,
  };
}
