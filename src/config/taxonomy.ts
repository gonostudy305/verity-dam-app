/**
 * VerityDAM Configurable Taxonomy Contract.
 *
 * The database table `verity_taxonomy_options` is the production source of
 * truth. These values are bootstrap defaults used only while the migration or
 * the taxonomy endpoint is unavailable; UI components consume useTaxonomy().
 */

export type TaxonomyFacet = 'category' | 'space' | 'status' | 'brand' | 'permission' | 'safety' | 'ecosystem';

export interface TaxonomySubItem {
  value: string;
  label: string;
  sortOrder?: number;
}

export interface TaxonomyItem {
  /** Stable value stored in media rows and used in query filters. */
  value: string;
  /** Editable label shown in the UI and sent to Vision as an allowed label. */
  label: string;
  sortOrder?: number;
  isActive?: boolean;
  /** Sub-branches under this taxonomy item. */
  subItems?: TaxonomySubItem[];
}

export interface TaxonomyConfig {
  category: TaxonomyItem[];
  space: TaxonomyItem[];
  status: TaxonomyItem[];
  brand: TaxonomyItem[];
  permission: TaxonomyItem[];
  safety: TaxonomyItem[];
  ecosystem: TaxonomyItem[];
  updatedAt: string | null;
}

const item = (value: string, label: string, subItems?: TaxonomySubItem[]): TaxonomyItem => ({
  value,
  label,
  subItems,
});

/** Neutral, industry-agnostic bootstrap taxonomy. */
export const DEFAULT_TAXONOMY: TaxonomyConfig = {
  category: [
    item('Ảnh Sản phẩm', 'Ảnh Sản phẩm', [
      { value: 'Sản phẩm chính', label: 'Sản phẩm chính' },
      { value: 'Góc cận / Chi tiết', label: 'Góc cận / Chi tiết' },
      { value: 'Bao bì / Đóng gói', label: 'Bao bì / Đóng gói' },
    ]),
    item('Ảnh Thực tế', 'Ảnh Thực tế', [
      { value: 'Hiện trường / Công trình', label: 'Hiện trường / Công trình' },
      { value: 'Không gian sử dụng', label: 'Không gian sử dụng' },
      { value: 'Showroom / Trưng bày', label: 'Showroom / Trưng bày' },
    ]),
    item('Ảnh Marketing & Đồ họa', 'Ảnh Marketing & Đồ họa', [
      { value: 'Banner / Poster', label: 'Banner / Poster' },
      { value: 'Render 3D', label: 'Render 3D' },
      { value: 'Mockup thương hiệu', label: 'Mockup thương hiệu' },
    ]),
  ],
  space: [
    item('Studio phông trắng', 'Studio phông trắng'),
    item('Không gian nội thất', 'Không gian nội thất'),
    item('Không gian ngoại thất', 'Không gian ngoại thất'),
    item('Showroom / Triển lãm', 'Showroom / Triển lãm'),
    item('Văn phòng làm việc', 'Văn phòng làm việc'),
    item('Toàn cảnh / Môi trường chung', 'Toàn cảnh / Môi trường chung'),
  ],
  status: [
    item('Đã xác thực', 'Đã xác thực'),
    item('Chờ kiểm chứng', 'Chờ kiểm chứng'),
    item('Đang sản xuất', 'Đang sản xuất'),
    item('Lưu trữ', 'Lưu trữ'),
  ],
  brand: [
    item('Acme Brand', 'Acme Brand'),
    item('Apex Goods', 'Apex Goods'),
    item('Lumina', 'Lumina'),
  ],
  permission: [
    item('public', 'Công khai'),
    item('internal', 'Chỉ nội bộ'),
  ],
  safety: [
    item('only_ai', 'Ảnh AI'),
    item('only_people', 'Có hình ảnh người'),
    item('only_internal', 'Chỉ lưu hành nội bộ'),
  ],
  ecosystem: [
    item('Tiêu chuẩn A', 'Tiêu chuẩn A'),
    item('Tiêu chuẩn B', 'Tiêu chuẩn B'),
    item('Dân dụng', 'Dân dụng'),
    item('Công nghiệp', 'Công nghiệp'),
  ],
  updatedAt: null,
};

export const CATEGORIES = DEFAULT_TAXONOMY.category;
export const SPACES = DEFAULT_TAXONOMY.space;
export const STATUSES = DEFAULT_TAXONOMY.status.map((entry) => entry.value);
export const BRANDS = DEFAULT_TAXONOMY.brand.map((entry) => entry.value);
export const PERMISSIONS = DEFAULT_TAXONOMY.permission;
export const SAFETY_FLAGS = DEFAULT_TAXONOMY.safety;
export const ECOSYSTEMS = DEFAULT_TAXONOMY.ecosystem;

export function activeItems(items: TaxonomyItem[]): TaxonomyItem[] {
  return (items || []).filter((entry) => entry.isActive !== false);
}

/** Resolve a stored stable value to the label currently configured by admins. */
export function taxonomyLabel(
  config: TaxonomyConfig,
  facet: TaxonomyFacet,
  value: string | null | undefined,
  fallback = value || ''
): string {
  if (!value) return fallback;
  return config[facet]?.find((entry) => entry.value === value)?.label || fallback;
}

export function buildVisionTaxonomyHint(config: TaxonomyConfig = DEFAULT_TAXONOMY): string {
  const cats = activeItems(config.category).map((entry) => entry.label).join(', ');
  const spaces = activeItems(config.space).map((entry) => entry.label).join(', ');
  const statuses = activeItems(config.status).map((entry) => entry.label).join(', ');
  const brands = activeItems(config.brand).map((entry) => entry.label).join(', ');
  return (
    'Allowed category values: ' + cats + '. ' +
    'Allowed space values: ' + spaces + '. ' +
    'Allowed status values: ' + statuses + '. ' +
    'Allowed brand values: ' + brands + '. ' +
    'Use null if the value is unclear rather than inventing a new label.'
  );
}
