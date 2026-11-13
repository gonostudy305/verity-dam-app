-- 0042_standardize_space_status_taxonomy.sql
-- Add "Ngoài trời / Cổng" to verity_taxonomy_options and standardize
-- historical free-form status and space values into canonical taxonomy values.

-- 1. Insert "Ngoài trời / Cổng" into verity_taxonomy_options
INSERT INTO public.verity_taxonomy_options (facet, value, label, sort_order, is_active)
VALUES ('space', 'Ngoài trời / Cổng', 'Ngoài trời / Cổng', 6, true)
ON CONFLICT (facet, value) DO UPDATE SET label = EXCLUDED.label, is_active = true;

-- 2. Standardize status across all media assets
UPDATE public.media_assets
SET status = 'Đã bàn giao'
WHERE lower(trim(status)) IN (
  'đã lắp đặt', 'installed', 'đã lắp đặt, có dấu hiệu sử dụng',
  'đã lắp đặt, đang kiểm tra hoàn thiện', 'đã lắp đặt và đang kiểm tra',
  'đã lắp đặt, công trình đang hoàn thiện', 'đã lắp đặt, đang hoàn thiện',
  'hoàn thiện lắp đặt', 'hoàn thiện', 'đã lắp đặt, cửa đang mở',
  'đã lắp đặt và đang sử dụng', 'đã lắp', 'hoàn thành'
);

UPDATE public.media_assets
SET status = 'Đang lắp'
WHERE lower(trim(status)) IN (
  'đang lắp đặt', 'đang lắp', 'đang thi công', 'đang hoàn thiện lắp đặt',
  'đang kiểm tra hoặc lắp đặt', 'đang lắp đặt và sử dụng', 'đang kiểm tra lắp đặt',
  'đang lắp đặt hoặc hoàn thiện', 'đang lắp đặt, còn màng bảo vệ',
  'đang chuẩn bị lắp đặt', 'đang cầm kiểm tra', 'installation', 'đang hoàn thiện'
);

UPDATE public.media_assets
SET status = 'Mới'
WHERE lower(trim(status)) IN (
  'chưa lắp đặt', 'mới, chưa lắp đặt', 'sản phẩm mới, chưa lắp đặt',
  'uninstalled', 'sản phẩm rời, chưa lắp đặt', 'chưa lắp đặt, đang trong hộp đóng gói',
  'mới, đang mở hộp', 'hàng mới đóng hộp', 'mới, đang đóng gói', 'mới, nguyên hộp',
  'mẫu trưng bày chưa lắp đặt', 'new', 'mới', 'mở hộp', 'đóng gói',
  'trưng bày', 'mẫu trưng bày', 'trưng bày, chưa lắp đặt'
);

-- 3. Standardize space across all media assets
UPDATE public.media_assets
SET space = 'Ngoài trời / Cổng'
WHERE lower(trim(space)) IN (
  'ngoài trời', 'lối vào ngoài trời', 'cổng ngoài trời', 'outdoor',
  'outdoor entrance', 'outdoor gate', 'cổng ngoài trời có mái che',
  'ngoài trời, cổng ra vào', 'lối vào ngoài trời có mái che',
  'cửa cổng', 'cổng', 'cổng nhà', 'ngoại thất', 'exterior'
);

UPDATE public.media_assets
SET space = 'Cửa chính'
WHERE lower(trim(space)) IN (
  'lối vào nhà', 'lối vào', 'lối vào công trình', 'lối vào nhà ở',
  'lối vào nhà phố', 'entrance', 'lối vào mặt tiền', 'lối vào biệt thự',
  'lối vào căn hộ', 'lối vào trong nhà', 'lối cửa trong nhà', 'lối ra vào trong nhà',
  'cửa ra vào', 'cửa ra vào nội thất', 'cửa nội thất', 'cửa gỗ',
  'cửa gỗ / cửa chống cháy', 'cửa nhôm xingfa', 'mặt tiền cơ sở kinh doanh',
  'nội thất', 'trong nhà', 'indoor', 'interior', 'residential interior',
  'không gian nội thất', 'nội thất nhà ở', 'không gian trong nhà',
  'trong nhà, tiếp giáp sân có mái che', 'sảnh nội thất', 'hành lang trong nhà',
  'hành lang nội thất', 'indoor entrance', 'lối vào nội thất',
  'không gian thương mại trong nhà', 'kho hàng', 'warehouse', 'kho',
  'kho trong nhà', 'kho hàng trong nhà', 'nhà xưởng',
  'xưởng hoặc khu vực lắp đặt trong nhà', 'không gian thi công trong nhà',
  'khu vực trưng bày hoặc kho trong nhà', 'kho hàng hoặc khu vực trưng bày sản phẩm',
  'nhà ở', 'nhà ở hiện đại', 'residential', 'văn phòng', 'căn hộ',
  'hành lang khách sạn'
);

-- 4. Set confidence to high (95) on pending items for status and space
UPDATE public.media_assets a
SET ai_confidence = jsonb_set(
  jsonb_set(coalesce(a.ai_confidence, '{}'::jsonb), '{status}', '95'::jsonb),
  '{space}', '95'::jsonb
)
FROM public.review_queue q
WHERE q.media_asset_id = a.id AND q.status = 'pending';