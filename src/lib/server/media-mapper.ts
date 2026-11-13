import type {
  AIConfidence,
  AIFlags,
  Dimensions,
  MediaAsset,
  MediaAssetProductLink,
  MediaPermission,
  MediaStatus,
  MediaType,
  OriginInfo,
  UsageRecord,
  CropConfig,
} from '@/types/media';

export type JsonRecord = Record<string, unknown>;

const MEDIA_TYPES = new Set<MediaType>(['photo', 'video', 'render', 'screenshot']);
const MEDIA_PERMISSIONS = new Set<MediaPermission>(['public', 'internal']);
const PRODUCT_LINK_ROLES = new Set<MediaAssetProductLink['role']>(['primary', 'secondary', 'background', 'packaging']);
const PRODUCT_LINK_REVIEW_STATES = new Set<MediaAssetProductLink['review_state']>(['draft', 'confirmed', 'rejected']);
const PUBLISH_STATUSES = new Set<NonNullable<MediaAsset['publish_status']>>(['not_requested', 'queued', 'published', 'failed']);

function objectValue(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {}
  }
  return {};
}

function stringValue(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arrayValue(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
      }
    } catch {}
  }
  return [];
}

function toMediaType(value: unknown): MediaType {
  return MEDIA_TYPES.has(value as MediaType) ? (value as MediaType) : 'photo';
}

function toMediaPermission(value: unknown): MediaPermission {
  return MEDIA_PERMISSIONS.has(value as MediaPermission) ? (value as MediaPermission) : 'public';
}

function toMediaStatus(value: unknown): MediaStatus {
  return typeof value === 'string' && value.trim() ? value.trim() : 'Mới';
}

function mapFlags(value: unknown): AIFlags {
  const flags = objectValue(value);
  return {
    is_ai: Boolean(flags.is_ai),
    is_internal: Boolean(flags.is_internal),
    has_people: Boolean(flags.has_people),
    tag_failed: Boolean(flags.tag_failed),
    is_broken: Boolean(flags.is_broken),
  };
}

function mapConfidence(value: unknown): AIConfidence {
  const confidence = objectValue(value);
  return {
    sku: numberValue(confidence.sku),
    brand: numberValue(confidence.brand),
    category: numberValue(confidence.category),
    space: numberValue(confidence.space),
    status: numberValue(confidence.status),
  };
}

function mapDimensions(value: unknown): Dimensions {
  const dimensions = objectValue(value);
  return {
    width: numberValue(dimensions.width),
    height: numberValue(dimensions.height),
    size_bytes: numberValue(dimensions.size_bytes),
  };
}

function mapOriginInfo(value: unknown, fallbackImportBatchId?: unknown): OriginInfo {
  const origin = objectValue(value);
  return {
    source: stringValue(origin.source, 'Upload'),
    source_type: stringValue(origin.source_type) || undefined,
    project_name: stringValue(origin.project_name) || undefined,
    project_hint: stringValue(origin.project_hint) || undefined,
    batch_id: stringValue(origin.batch_id) || undefined,
    uploaded_at: stringValue(origin.uploaded_at) || undefined,
    ticket_id: stringValue(origin.ticket_id) || undefined,
    uploader: stringValue(origin.uploader) || undefined,
    uploader_email: stringValue(origin.uploader_email) || undefined,
    batch_context: stringValue(origin.batch_context) || undefined,
    import_batch_id: stringValue(origin.import_batch_id) || stringValue(fallbackImportBatchId) || undefined,
  };
}

function mapCropConfigs(value: unknown): Record<string, CropConfig> | undefined {
  const raw = objectValue(value);
  const result: Record<string, CropConfig> = {};
  for (const [key, val] of Object.entries(raw)) {
    const crop = objectValue(val);
    const width = numberValue(crop.width);
    const height = numberValue(crop.height);
    if (width > 0 && height > 0) {
      result[key] = {
        x: numberValue(crop.x),
        y: numberValue(crop.y),
        width,
        height,
        rotation: typeof crop.rotation === 'number' ? crop.rotation : Number(crop.rotation) || 0,
        is_rounded: Boolean(crop.is_rounded),
        border_radius: typeof crop.border_radius === 'number' ? crop.border_radius : Number(crop.border_radius) || 16,
        updated_at: stringValue(crop.updated_at) || undefined,
        updated_by: stringValue(crop.updated_by) || undefined,
      };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapUsages(value: unknown): UsageRecord[] {
  return arrayValue(value).map((usage) => ({
    id: stringValue(usage.id),
    date: stringValue(usage.used_at),
    channel: stringValue(usage.channel),
    used_by: stringValue(usage.used_by),
    note: stringValue(usage.note) || undefined,
  }));
}

function storagePathFrom(row: JsonRecord, field: 'storage_path' | 'thumbnail_path') {
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Convert a joined media_asset_products/verity_products row (see
 * listMediaAssetProducts in native-media.ts) into the API contract. Kept a
 * pure, DB-free function -- like mapMediaAsset -- so the mapping itself is
 * unit-testable without a Postgres fixture. Defaults are conservative
 * (unknown role/state) rather than throwing on an unexpected DB value. */
export function mapMediaAssetProductLink(row: JsonRecord): MediaAssetProductLink {
  return {
    id: stringValue(row.id),
    product_id: stringValue(row.product_id),
    code: stringValue(row.code),
    display_name: stringValue(row.display_name),
    // Empty string counts as absent here (unlike stringValue's usual
    // fallback semantics) to match the same "unknown" default the DB-side
    // sync triggers already use (coalesce(nullif(trim(brand), ''), 'unknown')
    // in 0011_media_asset_product_sku_sync.sql).
    brand: stringValue(row.brand).trim() || 'unknown',
    model_name: stringValue(row.model_name) || undefined,
    category: stringValue(row.category) || undefined,
    role: PRODUCT_LINK_ROLES.has(row.role as MediaAssetProductLink['role']) ? (row.role as MediaAssetProductLink['role']) : 'secondary',
    confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence) ? row.confidence : null,
    source: stringValue(row.source),
    review_state: PRODUCT_LINK_REVIEW_STATES.has(row.review_state as MediaAssetProductLink['review_state']) ? (row.review_state as MediaAssetProductLink['review_state']) : 'draft',
    created_at: stringValue(row.created_at),
  };
}

/** Convert a native PostgreSQL row into the API media contract. */
export function mapMediaAsset(row: JsonRecord, publicUrls = new Map<string, string>()): MediaAsset {
  const storagePath = storagePathFrom(row, 'storage_path');
  const thumbnailPath = storagePathFrom(row, 'thumbnail_path');
  const rawOrigin = objectValue(row.origin_info);
  const cropConfigs = mapCropConfigs(row.crop_configs) || mapCropConfigs(rawOrigin.crop_configs);

  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    file_url: storagePath ? publicUrls.get(storagePath) || '' : stringValue(row.file_url),
    thumbnail_url: thumbnailPath
      ? publicUrls.get(thumbnailPath) || publicUrls.get(storagePath || '') || ''
      : storagePath
        ? publicUrls.get(storagePath) || ''
        : stringValue(row.thumbnail_url),
    guide_url: stringValue(row.guide_url) || undefined,
    media_type: toMediaType(row.media_type),
    duration: stringValue(row.duration) || undefined,
    sku: stringValue(row.sku),
    brand: stringValue(row.brand),
    category: stringValue(row.category),
    sub_category: stringValue(row.sub_category) || undefined,
    space: stringValue(row.space) || undefined,
    status: toMediaStatus(row.status),
    permission: toMediaPermission(row.permission),
    ai_flags: mapFlags(row.ai_flags),
    ai_confidence: mapConfidence(row.ai_confidence),
    suggested_caption: stringValue(row.suggested_caption) || undefined,
    author: stringValue(row.author),
    copyright: stringValue(row.copyright),
    credit: stringValue(row.credit),
    description: stringValue(row.description),
    keywords: Array.isArray(row.keywords) ? row.keywords.filter((keyword): keyword is string => typeof keyword === 'string') : [],
    visible_text: Array.isArray(row.visible_text) ? row.visible_text.filter((item): item is string => typeof item === 'string') : [],
    phash: stringValue(row.phash),
    dimensions: mapDimensions(row.dimensions),
    origin_info: mapOriginInfo(row.origin_info, row.import_batch_id),
    usage_count: numberValue(row.usage_count),
    usages: mapUsages(row.media_usages),
    crop_configs: cropConfigs,
    created_at: stringValue(row.created_at),
    updated_at: stringValue(row.updated_at) || undefined,
    deleted_at: stringValue(row.deleted_at) || undefined,
    deleted_by: stringValue(row.deleted_by) || undefined,
    publish_status: PUBLISH_STATUSES.has(row.publish_status as NonNullable<MediaAsset['publish_status']>) ? (row.publish_status as NonNullable<MediaAsset['publish_status']>) : 'not_requested',
    published_at: stringValue(row.published_at) || undefined,
    cdn_key: stringValue(row.cdn_key) || undefined,
    cdn_url: stringValue(row.cdn_url) || undefined,
    canonical_slug: stringValue(row.canonical_slug) || undefined,
    canonical_version: numberValue(row.canonical_version) || undefined,
    canonical_published_version: numberValue(row.canonical_published_version) || undefined,
    canonical_published_at: stringValue(row.canonical_published_at) || undefined,
    needs_post_production: Boolean(row.needs_post_production),
    has_open_report: Boolean(row.has_open_report),
  };
}
