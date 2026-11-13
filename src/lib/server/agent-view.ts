import type { MediaAsset } from '@/types/media';

/**
 * Compose a dense text block for agent consumption from MediaAsset structured fields.
 * No vision pass. Zero extra cost. Read-only field composition.
 *
 * Includes suggested_caption, keywords, visible_text, category, space, brand, status.
 */
export function composeAgentDescription(a: MediaAsset): string {
  const parts: string[] = [];

  if (a.suggested_caption) {
    parts.push(a.suggested_caption.trim());
  }

  const kws = a.keywords ?? [];
  if (kws.length > 0) {
    parts.push(`Từ khóa: ${kws.join(', ')}`);
  }

  const vt = a.visible_text ?? [];
  if (vt.length > 0) {
    parts.push(`Văn bản nhìn thấy: ${vt.join(', ')}`);
  }

  if (a.category) {
    parts.push(`Danh mục: ${a.category}`);
  }
  if (a.space) {
    parts.push(`Không gian: ${a.space}`);
  }
  if (a.brand) {
    parts.push(`Thương hiệu: ${a.brand}`);
  }
  if (a.status) {
    parts.push(`Trạng thái: ${a.status}`);
  }

  return parts.join(' | ');
}
