import type { DedupTier } from '@/types/dedup';

export const TIER_COPY: Record<DedupTier, { label: string; description: string; className: string }> = {
  exact: { label: 'TRÙNG CHÍNH XÁC', description: 'Cùng content hash', className: 'bg-bad-soft text-bad' },
  near: { label: 'RẤT CÓ THỂ TRÙNG', description: 'pHash gần nhau', className: 'bg-warn-soft text-warn' },
  similar: { label: 'ẢNH TƯƠNG TỰ', description: 'Cùng ngữ cảnh hình ảnh; cần người xem, không tự coi là trùng', className: 'bg-verity-soft text-verity-fg' },
};

export function tierLabel(tier: DedupTier) {
  return TIER_COPY[tier].label;
}
