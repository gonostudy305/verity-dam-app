import sharp from 'sharp';
import { normalizeMimeType } from '@/lib/media-api';

export interface ImageConvertResult {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  converted: boolean;
}

const WEBP_CONVERT_MIMES = new Set([
  'image/png',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);

const LARGE_JPEG_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MB

export function replaceExtension(fileName: string, newExt: string): string {
  const normalizedExt = newExt.startsWith('.') ? newExt : `.${newExt}`;
  return fileName.replace(/\.[a-zA-Z0-9]{1,10}$/, '') + normalizedExt;
}

/**
 * Optimizes/converts media buffers according to Verity storage rules:
 * - PNG, AVIF, GIF, HEIC, HEIF -> WebP (quality 82, preserve dimensions, auto-rotate EXIF)
 * - JPEG > 10MB -> re-encode JPEG (quality 88, progressive, auto-rotate EXIF)
 * - JPEG <= 10MB -> untouched passthrough
 * - WebP -> untouched passthrough
 * - video/* -> untouched passthrough
 */
export async function optimizeUploadBuffer(
  inputBuffer: Buffer,
  originalFileName: string,
  declaredMimeType: string
): Promise<ImageConvertResult> {
  const normMime = normalizeMimeType(declaredMimeType);

  // 1. Convert PNG, AVIF, GIF, HEIC, HEIF -> WebP (quality 82, no resize)
  if (WEBP_CONVERT_MIMES.has(normMime)) {
    const webpBuffer = await sharp(inputBuffer)
      .rotate()
      .webp({ quality: 82 })
      .toBuffer();

    const newFileName = replaceExtension(originalFileName, '.webp');
    return {
      buffer: webpBuffer,
      fileName: newFileName,
      mimeType: 'image/webp',
      sizeBytes: webpBuffer.length,
      converted: true,
    };
  }

  // 2. JPEG handling
  if (normMime === 'image/jpeg') {
    if (inputBuffer.length > LARGE_JPEG_THRESHOLD_BYTES) {
      const optimizedBuffer = await sharp(inputBuffer)
        .rotate()
        .jpeg({ quality: 88, progressive: true })
        .toBuffer();

      return {
        buffer: optimizedBuffer,
        fileName: originalFileName,
        mimeType: 'image/jpeg',
        sizeBytes: optimizedBuffer.length,
        converted: true,
      };
    }

    return {
      buffer: inputBuffer,
      fileName: originalFileName,
      mimeType: 'image/jpeg',
      sizeBytes: inputBuffer.length,
      converted: false,
    };
  }

  // 3. WebP or other formats (including video) - untouched passthrough
  return {
    buffer: inputBuffer,
    fileName: originalFileName,
    mimeType: normMime,
    sizeBytes: inputBuffer.length,
    converted: false,
  };
}
