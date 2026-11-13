import { ShieldCheck } from 'lucide-react';
import type { MediaAsset } from '@/types/media';

export function UsageProtectionBadge({ asset }: { asset: MediaAsset }) {
  const published = asset.publish_status === 'published' || Boolean(asset.published_at);
  const used = asset.usage_count > 0 || Boolean(asset.usages?.length);
  if (!published && !used) return <span className="text-[10px] text-text-3">Chưa có ràng buộc sử dụng</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {used && <span className="inline-flex items-center gap-1 rounded-full bg-warn-soft px-2 py-1 text-[10px] font-semibold text-warn" title="Asset có thể đang được dùng ở downstream channel">
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        Đang được dùng {asset.usage_count || asset.usages?.length || 0} lần
      </span>}
      {published && <span className="rounded-full bg-good-soft px-2 py-1 text-[10px] font-semibold text-good">Đã xuất bản</span>}
    </span>
  );
}
