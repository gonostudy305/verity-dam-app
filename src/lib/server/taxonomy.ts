import { ApiError } from './http';
import { requireNativeDatabase } from './native-db';
import {
  DEFAULT_TAXONOMY,
  type TaxonomyConfig,
  type TaxonomyFacet,
  type TaxonomyItem,
} from '@/config/taxonomy';

const TABLE = 'verity_taxonomy_options';
const FACETS: TaxonomyFacet[] = ['category', 'space', 'status', 'brand', 'permission', 'safety', 'ecosystem'];

type TaxonomyRow = {
  id: string;
  facet: TaxonomyFacet;
  value: string;
  label: string;
  sort_order: number;
  is_active: boolean;
  metadata?: { subItems?: { value: string; label: string; sortOrder?: number }[] } | null;
  updated_by: string | null;
  updated_at: string;
};

function taxonomyStoreUnavailable(error?: unknown): ApiError {
  if (error) console.error('Taxonomy configuration store error', error);
  return new ApiError(
    503,
    'TAXONOMY_STORE_UNAVAILABLE',
    'Kho cấu hình bộ lọc chưa sẵn sàng. Hãy chạy native PostgreSQL migrations trước.'
  );
}

function cloneDefault(): TaxonomyConfig {
  return {
    category: DEFAULT_TAXONOMY.category.map((item) => ({ ...item })),
    space: DEFAULT_TAXONOMY.space.map((item) => ({ ...item })),
    status: DEFAULT_TAXONOMY.status.map((item) => ({ ...item })),
    brand: DEFAULT_TAXONOMY.brand.map((item) => ({ ...item })),
    permission: DEFAULT_TAXONOMY.permission.map((item) => ({ ...item })),
    safety: DEFAULT_TAXONOMY.safety.map((item) => ({ ...item })),
    ecosystem: DEFAULT_TAXONOMY.ecosystem.map((item) => ({ ...item })),
    updatedAt: null,
  };
}

export function asConfig(rows: TaxonomyRow[], includeInactive: boolean): TaxonomyConfig {
  const config = cloneDefault();
  for (const facet of FACETS) config[facet] = [];
  for (const row of rows) {
    if (!includeInactive && !row.is_active) continue;
    // Defensive guard: skip unknown or unsupported facets safely without throwing TypeError
    if (!config[row.facet]) continue;
    config[row.facet].push({
      value: row.value,
      label: row.label,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      subItems: row.metadata?.subItems,
    });
  }
  for (const facet of FACETS) {
    if (config[facet]) {
      config[facet].sort((left, right) =>
        (left.sortOrder ?? 100) - (right.sortOrder ?? 100) || left.label.localeCompare(right.label, 'vi')
      );
    }
  }
  config.updatedAt = rows.reduce<string | null>(
    (latest, row) => (!latest || row.updated_at > latest ? row.updated_at : latest),
    null
  );
  return config;
}

export async function getTaxonomyConfig(includeInactive = false): Promise<TaxonomyConfig> {
  try {
    const result = await requireNativeDatabase().query<TaxonomyRow>(
      `select id, facet, value, label, sort_order, is_active, updated_by, updated_at
       from public.${TABLE} order by facet asc, sort_order asc, label asc`
    );
    return asConfig(result.rows, includeInactive);
  } catch (error) {
    throw taxonomyStoreUnavailable(error);
  }
}

function validateOption(raw: unknown, index: number): TaxonomyRow | Omit<TaxonomyRow, 'id' | 'updated_at'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Tùy chọn bộ lọc #${index + 1} không hợp lệ.`);
  }
  const value = raw as Record<string, unknown>;
  const facet = value.facet;
  const optionValue = value.value;
  const label = value.label;
  const sortOrder = value.sortOrder;
  const isActive = value.isActive;
  if (!FACETS.includes(facet as TaxonomyFacet)) {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Facet của tùy chọn #${index + 1} không hợp lệ.`);
  }
  if (facet === 'permission' && !['public', 'internal'].includes(String(optionValue))) {
    throw new ApiError(400, 'INVALID_TAXONOMY', 'Quyền dùng chỉ hỗ trợ public hoặc internal.');
  }
  if (facet === 'safety' && !['only_ai', 'only_people', 'only_internal'].includes(String(optionValue))) {
    throw new ApiError(400, 'INVALID_TAXONOMY', 'Cờ an toàn không được mở rộng ngoài các cờ hệ thống.');
  }
  if (typeof optionValue !== 'string' || !/^[^\u0000\n\r]{1,80}$/.test(optionValue.trim())) {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Giá trị của tùy chọn #${index + 1} không hợp lệ.`);
  }
  if (typeof label !== 'string' || !/^[^\u0000\n\r]{1,100}$/.test(label.trim())) {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Nhãn của tùy chọn #${index + 1} không hợp lệ.`);
  }
  if (!Number.isInteger(sortOrder) || (sortOrder as number) < 0 || (sortOrder as number) > 10000) {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Thứ tự của tùy chọn #${index + 1} không hợp lệ.`);
  }
  if (typeof isActive !== 'boolean') {
    throw new ApiError(400, 'INVALID_TAXONOMY', `Trạng thái của tùy chọn #${index + 1} không hợp lệ.`);
  }
  return {
    facet: facet as TaxonomyFacet,
    value: optionValue.trim(),
    label: label.trim(),
    sort_order: sortOrder as number,
    is_active: isActive,
    updated_by: null,
  };
}

export async function saveTaxonomyConfig(value: unknown, updatedBy: string): Promise<TaxonomyConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_TAXONOMY', 'Nội dung cấu hình bộ lọc không hợp lệ.');
  }
  const rawOptions = (value as { options?: unknown }).options;
  if (!Array.isArray(rawOptions) || rawOptions.length > 300) {
    throw new ApiError(400, 'INVALID_TAXONOMY', 'Danh sách bộ lọc không hợp lệ.');
  }
  const options = rawOptions.map(validateOption);
  const seen = new Set<string>();
  const labels = new Set<string>();
  const valuesByFacet = new Map<TaxonomyFacet, Set<string>>();
  for (const option of options) {
    const key = `${option.facet}:${option.value}`.toLocaleLowerCase('vi');
    if (seen.has(key)) throw new ApiError(400, 'INVALID_TAXONOMY', 'Không được trùng giá trị trong cùng một nhóm.');
    seen.add(key);
    const facetValues = valuesByFacet.get(option.facet) || new Set<string>();
    facetValues.add(option.value.toLocaleLowerCase('vi'));
    valuesByFacet.set(option.facet, facetValues);
    const labelKey = `${option.facet}:${option.label}`.toLocaleLowerCase('vi');
    if (labels.has(labelKey)) throw new ApiError(400, 'INVALID_TAXONOMY', 'Không được trùng nhãn trong cùng một nhóm.');
    labels.add(labelKey);
  }
  for (const option of options) {
    const valueKey = option.value.toLocaleLowerCase('vi');
    const labelKey = option.label.toLocaleLowerCase('vi');
    if (labelKey !== valueKey && valuesByFacet.get(option.facet)?.has(labelKey)) {
      throw new ApiError(400, 'INVALID_TAXONOMY', 'Nhãn không được trùng stable value của tùy chọn khác trong cùng nhóm.');
    }
  }
  for (const facet of ['category', 'space', 'status', 'brand', 'permission', 'safety'] as const) {
    if (!options.some((option) => option.facet === facet && option.is_active)) {
      throw new ApiError(400, 'INVALID_TAXONOMY', `Nhóm ${facet} phải còn ít nhất một tùy chọn đang bật.`);
    }
  }

  const database = requireNativeDatabase();
  let existingRows: Array<{ facet: TaxonomyFacet; value: string }>;
  try {
    existingRows = (await database.query<{ facet: TaxonomyFacet; value: string }>(`select facet, value from public.${TABLE}`)).rows;
  } catch (error) {
    throw taxonomyStoreUnavailable(error);
  }
  const submittedKeys = new Set(options.map((option) => `${option.facet}:${option.value}`));
  for (const row of existingRows as Array<{ facet: TaxonomyFacet; value: string }>) {
    const key = `${row.facet}:${row.value}`;
    if (!submittedKeys.has(key)) {
      throw new ApiError(400, 'INVALID_TAXONOMY', 'Không được xóa stable value đã tồn tại; hãy tắt tùy chọn thay vì xóa.');
    }
  }
  try {
    const client = await database.connect();
    try {
      await client.query('begin');
      for (const option of options) {
        await client.query(
          `insert into public.${TABLE}(facet, value, label, sort_order, is_active, updated_by, updated_at)
           values ($1,$2,$3,$4,$5,$6,now())
           on conflict(facet,value) do update set label=excluded.label, sort_order=excluded.sort_order,
             is_active=excluded.is_active, updated_by=excluded.updated_by, updated_at=now()`,
          [option.facet, option.value, option.label, option.sort_order, option.is_active, updatedBy]
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    throw taxonomyStoreUnavailable(error);
  }
  return getTaxonomyConfig(true);
}
