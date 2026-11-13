-- Settings-configurable batch context quick-select for the upload page
-- (Mẫu nhanh presets + tag groups shown in BatchContextSelector.tsx).
-- Singleton-row table, same shape convention as verity_synonyms_config /
-- verity_search_config: one 'default' row, jsonb payload, cache-busted on
-- write by src/lib/server/upload-context-config.ts.
--
-- Seeded with the CURRENT hardcoded values from
-- src/config/upload-context.ts (DEFAULT_UPLOAD_CONTEXT) so this migration
-- is a zero behavior-change deploy: the upload page renders identically
-- until an admin edits Settings > Ngữ cảnh Upload.

create table if not exists public.verity_upload_context_config (
  config_key text primary key default 'default',
  quick_presets jsonb not null default '[]'::jsonb,
  tag_groups jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into public.verity_upload_context_config (config_key, quick_presets, tag_groups)
values (
  'default',
  '[
    {"label": "Công trình bàn giao", "icon": "🏗️", "value": "Thi công công trình thực tế, đã bàn giao hoàn thiện"},
    {"label": "Chụp tại Showroom", "icon": "🏬", "value": "Ảnh chụp thực tế trưng bày tại Showroom VerityDAM"},
    {"label": "Studio bán lẻ", "icon": "🛍️", "value": "Ảnh chụp sản phẩm Studio phông nền trắng"}
  ]'::jsonb,
  '[
    {"name": "Loại hình", "icon": "Building2", "tags": ["Công trình thực tế", "Showroom trưng bày", "Studio nền trắng", "Banner Marketing", "Ảnh lỗi / Bảo hành"]},
    {"name": "Không gian", "icon": "Home", "tags": ["Cửa chính (Khóa cửa)", "Cổng sắt / Ngoài trời", "Phòng khách", "Bếp & Ăn", "Phòng ngủ", "Phòng tắm / WC", "Tủ điện / Kỹ thuật", "Sân vườn / Ban công"]},
    {"name": "Hệ thống & Thiết bị", "icon": "Cpu", "tags": ["Hệ Acme & HomeKit", "Hệ Tera / Smart Life", "Robot Drift / Rover", "Đèn Lumos / Philips", "Camera an ninh & Cảm biến", "WiFi Mesh & Ổ cứng NAS", "Gia dụng & Lọc không khí"]},
    {"name": "Tiến độ", "icon": "CheckCircle2", "tags": ["Khảo sát hiện trạng", "Đang thi công dở dang", "Đã bàn giao hoàn thiện", "Mới đập hộp (Unboxing)"]}
  ]'::jsonb
)
on conflict (config_key) do nothing;
