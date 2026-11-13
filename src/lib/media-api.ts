import { TAGGABLE_ROLE_SET, type TaggableRole } from '@/lib/product-role';
import type { AIConfidence, MediaType } from '@/types/media';

export const MAX_UPLOAD_FILES = 100;
export const MAX_IMAGE_SIZE_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024;

const MIME_TO_MEDIA_TYPE: Record<string, MediaType> = {
  'image/jpeg': 'photo',
  'image/png': 'photo',
  'image/webp': 'photo',
  'image/avif': 'photo',
  'image/gif': 'photo',
  'image/heic': 'photo',
  'image/heif': 'photo',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
};

const SORT_OPTIONS = new Set(['newest', 'most_used', 'unused']);
const REVIEW_DECISIONS = new Set(['approved', 'rejected', 'skipped']);
const REVIEW_PATCH_KEYS = new Set([
  'title',
  'sku',
  'brand',
  'category',
  'space',
  'status',
  'permission',
  'suggested_caption',
  'author',
  'copyright',
  'credit',
  'description',
  'keywords',
]);

export type ReviewPatchField =
  | 'title'
  | 'sku'
  | 'brand'
  | 'category'
  | 'space'
  | 'status'
  | 'permission'
  | 'suggested_caption'
  | 'author'
  | 'copyright'
  | 'credit'
  | 'description'
  | 'keywords';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface UploadCandidate {
  name: unknown;
  size: unknown;
  type: unknown;
}

export interface ValidatedUpload {
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  mediaType: MediaType;
}

export interface MediaListParams {
  query: string;
  category: string[];
  space: string[];
  status: string[];
  permission: string[];
  source: string[];
  mediaType: string[];
  onlyAi: boolean;
  onlyPeople: boolean;
  onlyInternal: boolean;
  onlyNeedsPostProduction?: boolean;
  onlyReported?: boolean;
  sort: 'newest' | 'most_used' | 'unused';
  page: number;
  pageSize: number;
}

export function normalizeMimeType(mime: unknown): string {
  if (typeof mime !== 'string') return '';
  return mime.split(';')[0].trim().toLowerCase();
}

const EQUIVALENT_MIME_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['image/heic', 'image/heif']),
  new Set(['video/mp4', 'video/quicktime']),
];

export function areCompatibleMimeTypes(actual: string, expected: string): boolean {
  const normActual = normalizeMimeType(actual);
  const normExpected = normalizeMimeType(expected);
  if (!normActual || !normExpected) return false;
  if (normActual === normExpected) return true;
  return EQUIVALENT_MIME_GROUPS.some((group) => group.has(normActual) && group.has(normExpected));
}

export function validateUploadCandidate(candidate: UploadCandidate): ValidatedUpload {
  const fileName = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  let mimeType = normalizeMimeType(candidate.type);
  const lowerName = fileName.toLowerCase();

  // Heuristic fallback for HEIC/HEIF when browser (Windows/Android) sends empty or generic octet-stream MIME
  if (!mimeType || mimeType === 'application/octet-stream') {
    if (lowerName.endsWith('.heic')) {
      mimeType = 'image/heic';
    } else if (lowerName.endsWith('.heif')) {
      mimeType = 'image/heif';
    }
  }

  const sizeBytes = typeof candidate.size === 'number' ? candidate.size : Number(candidate.size);
  const mediaType = MIME_TO_MEDIA_TYPE[mimeType];

  if (!fileName || fileName.length > 255) {
    throw new ValidationError('Tên tệp không hợp lệ.');
  }
  if (!mediaType) {
    throw new ValidationError('Chỉ hỗ trợ JPEG, PNG, WebP, AVIF, GIF, HEIC, MP4, WebM và MOV.');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new ValidationError('Dung lượng tệp không hợp lệ.');
  }

  const maximum = mediaType === 'video' ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
  if (sizeBytes > maximum) {
    throw new ValidationError(
      mediaType === 'video'
        ? 'Video không được vượt quá 200 MB.'
        : 'Ảnh không được vượt quá 50 MB.'
    );
  }

  return { fileName, sizeBytes, mimeType, mediaType };
}

export function createStorageFileName(fileName: string): string {
  const extensionMatch = /\.([a-zA-Z0-9]{1,10})$/.exec(fileName);
  const extension = extensionMatch ? `.${extensionMatch[1].toLowerCase()}` : '';
  const stem = fileName
    .slice(0, extensionMatch?.index ?? fileName.length)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return `${stem || 'upload'}${extension}`;
}

export function parseMediaListParams(searchParams: URLSearchParams): MediaListParams {
  const list = (name: string) =>
    [...new Set(
      searchParams
        .getAll(name)
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 80)
    )];

  const rawQuery = (searchParams.get('q') || '').trim();
  const query = rawQuery
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  const rawSort = searchParams.get('sort') || 'newest';
  const sort = SORT_OPTIONS.has(rawSort) ? (rawSort as MediaListParams['sort']) : 'newest';
  const numberParam = (name: string, fallback: number, maximum: number) => {
    const value = Number(searchParams.get(name));
    return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
  };

  return {
    query,
    category: list('category'),
    space: list('space'),
    status: list('status'),
    permission: list('permission'),
    source: list('source'),
    mediaType: list('media_type'),
    onlyAi: searchParams.get('only_ai') === 'true',
    onlyPeople: searchParams.get('only_people') === 'true',
    onlyInternal: searchParams.get('only_internal') === 'true',
    onlyNeedsPostProduction: searchParams.get('only_needs_post_production') === 'true',
    onlyReported: searchParams.get('only_reported') === 'true',
    sort,
    page: numberParam('page', 1, 10_000),
    pageSize: numberParam('page_size', 40, 100),
  };
}

export function parseReviewDecision(value: unknown): 'approved' | 'rejected' | 'skipped' {
  if (typeof value !== 'string' || !REVIEW_DECISIONS.has(value)) {
    throw new ValidationError('Quyết định duyệt không hợp lệ.');
  }
  return value as 'approved' | 'rejected' | 'skipped';
}

export function sanitizeReviewPatch(value: unknown): Record<string, string | string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string | string[]>>(
    (patch, [key, rawValue]) => {
      if (!REVIEW_PATCH_KEYS.has(key)) return patch;
      if (key === 'keywords') {
        if (Array.isArray(rawValue)) {
          patch[key] = rawValue
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && item.length <= 100);
        } else if (typeof rawValue === 'string') {
          patch[key] = rawValue
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0 && item.length <= 100);
        }
      } else if (typeof rawValue === 'string') {
        const maxLen = key === 'suggested_caption' || key === 'description' ? 2_000 : 200;
        patch[key] = rawValue.trim().slice(0, maxLen);
      }
      return patch;
    },
    {}
  );
}

/**
 * Optional batch-only allow-list. When absent, callers retain the legacy
 * endpoint contract. When present, only explicitly opted-in fields may be
 * applied across a selected batch.
 */
export function sanitizeReviewPatchFields(value: unknown): Set<ReviewPatchField> | null {
  if (!Array.isArray(value)) return null;
  return new Set(
    value.filter((field): field is ReviewPatchField =>
      typeof field === 'string' && REVIEW_PATCH_KEYS.has(field)
    )
  );
}

export function restrictReviewPatchToFields<T extends Record<string, unknown>>(
  patch: T,
  patchFields: ReadonlySet<string> | null
): T {
  if (!patchFields) return patch;
  return Object.fromEntries(
    Object.entries(patch).filter(([field]) => patchFields.has(field))
  ) as T;
}

/**
 * Corrections are deliberately sent independently from the full form patch.
 * This is what lets the database route SKU edits to embedding references and open
 * metadata edits to the vision few-shot pool without treating an unchanged
 * prefilled field as a training sample.
 */
export function sanitizeReviewCorrections(value: unknown): Record<string, true> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value
      .filter((key): key is string => typeof key === 'string' && REVIEW_PATCH_KEYS.has(key))
      .map((key) => [key, true])
  ) as Record<string, true>;
}

export function sanitizeReviewNonCatalog(value: unknown): boolean {
  return value === true;
}

export function sanitizeReviewPromoteReference(value: unknown): boolean {
  return value === true;
}

export function sanitizeReviewNeedsPostProduction(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

export interface ReviewProductLinkInput {
  sku: string;
  role: TaggableRole;
}

/**
 * Phase 03: Sanitize reviewer-picked product tags.
 * Caps at 12 items, trims SKU, rejects primary role, dedupes case-insensitively,
 * ensures role is in TAGGABLE_ROLES.
 */
export function sanitizeReviewProductLinks(value: unknown): ReviewProductLinkInput[] {
  if (!Array.isArray(value)) return [];
  const result: ReviewProductLinkInput[] = [];
  const seenSkus = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const sku = typeof raw.sku === 'string' ? raw.sku.trim() : '';
    if (!sku || sku.length > 100) continue;

    const lowerSku = sku.toLowerCase();
    if (seenSkus.has(lowerSku)) continue;

    const role = typeof raw.role === 'string' ? raw.role.trim() : 'secondary';
    if (role === 'primary' || !TAGGABLE_ROLE_SET.has(role)) continue;

    seenSkus.add(lowerSku);
    result.push({
      sku,
      role: role as TaggableRole,
    });

    if (result.length >= 12) break;
  }

  return result;
}


export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Detects whether a search query or input string is a media URL, storage path, or file candidate.
 * Used for fast-path routing to reverse-lookup instead of standard text NLP search.
 */
export function isMediaUrlOrPathCandidate(input: string): boolean {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('wp-content/') ||
    trimmed.startsWith('/wp-content/') ||
    trimmed.startsWith('/media/') ||
    trimmed.startsWith('media/') ||
    /\.(webp|jpg|jpeg|png|gif|heic|svg)(\?.*)?$/i.test(trimmed)
  );
}
