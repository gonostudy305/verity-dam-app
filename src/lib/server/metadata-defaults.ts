import { ApiError } from './http';
import { requireNativeDatabase } from './native-db';

const CONFIG_TABLE = 'verity_metadata_defaults_config';
const CONFIG_KEY = 'default';

const MAX_TEXT_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_LENGTH = 80;

/** Fallback shown when the shared row has not been seeded/reachable yet. */
export const SHARED_METADATA_DEFAULTS = {
  author: 'VerityDAM Platform',
  copyright: '© 2026 VerityDAM Platform. All rights reserved.',
  credit: 'VerityDAM Team',
  description: 'Hình ảnh sản phẩm, tư liệu truyền thông và tài sản số chính hãng LocknLock.',
  keywords: ['locknlock', 'lock&lock', 'gia dụng', 'nhà bếp', 'bình giữ nhiệt', 'hộp bảo quản'],
  autoApply: true,
  licenseUrl: 'https://veritydam.example/chinh-sach-ban-quyen-hinh-anh',
  licensorName: 'VerityDAM Platform',
  licensorUrl: 'https://veritydam.example/cap-phep-hinh-anh',
  acquireLicensePage: 'https://veritydam.example/cap-phep-hinh-anh',
  webStatementUrl: 'https://veritydam.example/chinh-sach-ban-quyen-hinh-anh',
} as const;

type ConfigRow = {
  config_key: string;
  author: string;
  copyright: string;
  credit: string;
  description: string;
  keywords: string[];
  auto_apply: boolean;
  updated_at: string;
  license_url?: string | null;
  licensor_name?: string | null;
  licensor_url?: string | null;
  acquire_license_page?: string | null;
  web_statement_url?: string | null;
};

export type SharedMetadataDefaults = {
  author: string;
  copyright: string;
  credit: string;
  description: string;
  keywords: string[];
  autoApply: boolean;
  updatedAt: string | null;
  licenseUrl: string;
  licensorName: string;
  licensorUrl: string;
  acquireLicensePage: string;
  webStatementUrl: string;
};

function configStoreUnavailable() {
  return new ApiError(
    503,
    'METADATA_DEFAULTS_STORE_UNAVAILABLE',
    'Kho cấu hình Metadata mặc định chưa sẵn sàng. Hãy chạy migration PostgreSQL và kiểm tra server secrets.'
  );
}

function asView(row: ConfigRow | null): SharedMetadataDefaults {
  if (!row) {
    return { ...SHARED_METADATA_DEFAULTS, keywords: [...SHARED_METADATA_DEFAULTS.keywords], updatedAt: null };
  }
  return {
    author: row.author,
    copyright: row.copyright,
    credit: row.credit,
    description: row.description,
    keywords: row.keywords,
    autoApply: row.auto_apply,
    updatedAt: row.updated_at,
    licenseUrl: row.license_url ?? SHARED_METADATA_DEFAULTS.licenseUrl,
    licensorName: row.licensor_name ?? SHARED_METADATA_DEFAULTS.licensorName,
    licensorUrl: row.licensor_url ?? SHARED_METADATA_DEFAULTS.licensorUrl,
    acquireLicensePage: row.acquire_license_page ?? SHARED_METADATA_DEFAULTS.acquireLicensePage,
    webStatementUrl: row.web_statement_url ?? SHARED_METADATA_DEFAULTS.webStatementUrl,
  };
}

function validateText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApiError(
      400,
      'INVALID_METADATA_DEFAULTS',
      `Trường "${field}" không hợp lệ (tối đa ${maxLength} ký tự).`
    );
  }
  return value;
}

function validateKeywords(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const invalid =
    !Array.isArray(value) ||
    value.length > MAX_KEYWORDS ||
    value.some((keyword) => typeof keyword !== 'string' || keyword.length > MAX_KEYWORD_LENGTH);
  if (invalid) {
    throw new ApiError(
      400,
      'INVALID_METADATA_DEFAULTS',
      `Danh sách từ khóa không hợp lệ (tối đa ${MAX_KEYWORDS} từ, mỗi từ tối đa ${MAX_KEYWORD_LENGTH} ký tự).`
    );
  }
  return (value as string[]).map((keyword) => keyword.trim()).filter(Boolean);
}

function validateUrl(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ApiError(
      400,
      'INVALID_METADATA_DEFAULTS',
      `Trường "${field}" không hợp lệ (tối đa ${maxLength} ký tự).`
    );
  }
  const trimmed = value.trim();
  if (trimmed && !trimmed.startsWith('https://') && !trimmed.startsWith('http://')) {
    throw new ApiError(
      400,
      'INVALID_METADATA_DEFAULTS',
      `Trường "${field}" phải là một URL hợp lệ (bắt đầu bằng https:// hoặc http://).`
    );
  }
  return trimmed;
}

function validateAutoApply(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'INVALID_METADATA_DEFAULTS', 'Giá trị "auto_apply" phải là true/false.');
  }
  return value;
}

async function getRow(): Promise<ConfigRow | null> {
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(`select * from public.${CONFIG_TABLE} where config_key = $1 limit 1`, [CONFIG_KEY]);
    return result.rows[0] || null;
  } catch {
    throw configStoreUnavailable();
  }
}

export async function getSharedMetadataDefaults(): Promise<SharedMetadataDefaults> {
  return asView(await getRow());
}

/**
 * Partial update: any field omitted from `value` keeps its current (or
 * default) value rather than being cleared, so the Settings UI can save one
 * changed field at a time.
 */
export async function saveSharedMetadataDefaults(
  value: unknown,
  updatedBy?: string
): Promise<SharedMetadataDefaults> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_METADATA_DEFAULTS', 'Nội dung cấu hình Metadata mặc định không hợp lệ.');
  }
  const body = value as Record<string, unknown>;
  const existing = await getRow();

  const author =
    validateText(body.author, 'Author', MAX_TEXT_LENGTH) ?? existing?.author ?? SHARED_METADATA_DEFAULTS.author;
  const copyright =
    validateText(body.copyright, 'Copyright', MAX_TEXT_LENGTH) ??
    existing?.copyright ??
    SHARED_METADATA_DEFAULTS.copyright;
  const credit =
    validateText(body.credit, 'Credit', MAX_TEXT_LENGTH) ?? existing?.credit ?? SHARED_METADATA_DEFAULTS.credit;
  const description =
    validateText(body.description, 'Description', MAX_DESCRIPTION_LENGTH) ??
    existing?.description ??
    SHARED_METADATA_DEFAULTS.description;
  const keywords =
    validateKeywords(body.keywords) ?? existing?.keywords ?? [...SHARED_METADATA_DEFAULTS.keywords];
  const autoApply =
    validateAutoApply(body.autoApply) ?? existing?.auto_apply ?? SHARED_METADATA_DEFAULTS.autoApply;
  const licenseUrl =
    validateUrl(body.licenseUrl, 'License URL', MAX_TEXT_LENGTH) ??
    existing?.license_url ??
    SHARED_METADATA_DEFAULTS.licenseUrl;
  const licensorName =
    validateText(body.licensorName, 'Licensor Name', MAX_TEXT_LENGTH) ??
    existing?.licensor_name ??
    SHARED_METADATA_DEFAULTS.licensorName;
  const licensorUrl =
    validateUrl(body.licensorUrl, 'Licensor URL', MAX_TEXT_LENGTH) ??
    existing?.licensor_url ??
    SHARED_METADATA_DEFAULTS.licensorUrl;
  const acquireLicensePage =
    validateUrl(body.acquireLicensePage, 'Acquire License Page', MAX_TEXT_LENGTH) ??
    existing?.acquire_license_page ??
    SHARED_METADATA_DEFAULTS.acquireLicensePage;
  const webStatementUrl =
    validateUrl(body.webStatementUrl, 'Web Statement URL', MAX_TEXT_LENGTH) ??
    existing?.web_statement_url ??
    SHARED_METADATA_DEFAULTS.webStatementUrl;

  try {
    const result = await requireNativeDatabase().query<ConfigRow>(
      `insert into public.${CONFIG_TABLE}(
         config_key, author, copyright, credit, description, keywords, auto_apply,
         license_url, licensor_name, licensor_url, acquire_license_page, web_statement_url,
         updated_by, updated_at
       )
       values ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11,$12,$13,now())
       on conflict(config_key) do update set
         author=excluded.author, copyright=excluded.copyright, credit=excluded.credit,
         description=excluded.description, keywords=excluded.keywords, auto_apply=excluded.auto_apply,
         license_url=excluded.license_url, licensor_name=excluded.licensor_name, licensor_url=excluded.licensor_url,
         acquire_license_page=excluded.acquire_license_page, web_statement_url=excluded.web_statement_url,
         updated_by=excluded.updated_by, updated_at=now() returning *`,
      [
        CONFIG_KEY,
        author,
        copyright,
        credit,
        description,
        keywords,
        autoApply,
        licenseUrl,
        licensorName,
        licensorUrl,
        acquireLicensePage,
        webStatementUrl,
        updatedBy || null,
      ]
    );
    return asView(result.rows[0] || null);
  } catch {
    throw configStoreUnavailable();
  }
}
