'use client';

import React from 'react';
import { VerityBadge } from '@/components/common/VerityBadge';
import { VerityChip } from '@/components/common/VerityChip';
import { BookOpen, Sparkles, Zap, Shield } from 'lucide-react';

export function DesignSpecView() {
  return (
    <div className="mx-auto max-w-[1180px] space-y-4 p-3 sm:space-y-6 sm:p-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 sm:gap-4">
        {/* 1. Hệ Badge */}
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="flex items-center gap-2 text-[14px] font-bold text-text-1">
            <Shield className="w-4 h-4 text-verity" />
            <span>1. Hệ Badge (Badge System)</span>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            <VerityBadge variant="private">Chỉ nội bộ</VerityBadge>
            <VerityBadge variant="ai">Ảnh AI</VerityBadge>
            <VerityBadge variant="warn">Có người trong hình</VerityBadge>
            <VerityBadge variant="ok">Public</VerityBadge>
            <VerityBadge variant="gold">Trùng</VerityBadge>
            <VerityBadge variant="solid">Đang tag</VerityBadge>
          </div>
          <p className="text-[12.5px] text-text-2 leading-relaxed pt-1">
            <b>Nguyên tắc:</b> Nền tint nhạt + chữ đậm cùng tông là mặc định. Solid chỉ dành cho trạng thái đang xử lý (“Đang tag”) và cảnh báo trùng (nền vàng #FFD60D + chữ tối — vàng không bao giờ làm màu chữ).
          </p>
        </div>

        {/* 2. Card ảnh */}
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="flex items-center gap-2 text-[14px] font-bold text-text-1">
            <Sparkles className="w-4 h-4 text-verity" />
            <span>2. Card ảnh & Quy tắc an toàn</span>
          </div>
          <p className="text-[12.5px] text-text-2 leading-relaxed">
            Bo 12px · viền hairline · shadow thấp. Badge cảnh báo (<b>AI / Chỉ nội bộ / Có người</b>) <b className="text-text-1">luôn hiển thị</b> ở góc trên trái với nền mờ chống lóa, không phụ thuộc hover. Hover mới hiện: checkbox chọn, badge nguồn, SKU mono, nút copy link.
          </p>
        </div>

        {/* 3. Micro-interactions */}
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="flex items-center gap-2 text-[14px] font-bold text-text-1">
            <Zap className="w-4 h-4 text-verity" />
            <span>3. Micro-interactions & Vòng học AI</span>
          </div>
          <div className="space-y-2 text-[12.5px] text-text-2 leading-relaxed">
            <p>
              <b className="text-text-1">Learning ring:</b> Khi sửa một trường do AI điền sẵn, trường đó viền phát sáng cam <code>--learn #C2701A</code> trong 1000ms kèm nhãn <code>đã ghi nhận</code> rồi tắt mềm. Không popup, không toast làm gián đoạn nhịp duyệt.
            </p>
            <p>
              <b className="text-text-1">Confidence Meter:</b> Thanh 46×4px hiển thị độ tin cậy của AI (xanh ≥ 85%, cam &lt; 85%) giúp người duyệt nhìn nhanh vào trường cần soi.
            </p>
          </div>
        </div>

        {/* 4. Cảnh báo trùng lặp */}
        <div className="space-y-3 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
          <div className="flex items-center gap-2 text-[14px] font-bold text-text-1">
            <Sparkles className="w-4 h-4 text-gold-ink" />
            <span>4. Banner trùng lặp (Duplicate Detection)</span>
          </div>
          <div className="p-3 rounded-xl bg-gold/10 border border-gold-border text-[12.5px] font-medium text-text-1">
            <b>Giống 92% với 3 ảnh đã có</b> · So sánh thumbnail · Nút “Vẫn giữ” / “Bỏ, dùng ảnh cũ”
          </div>
          <p className="text-[12px] text-text-2 leading-relaxed">
            Xuất hiện cả lúc upload (viền vàng trên card) và trong màn duyệt. Hệ thống không bao giờ tự ý xóa ảnh của người dùng.
          </p>
        </div>
      </div>
    </div>
  );
}
