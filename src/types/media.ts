export type MediaType = 'photo' | 'video' | 'render' | 'screenshot';
export type MediaPermission = 'public' | 'internal';
// Status values are configured in the PostgreSQL taxonomy and can be extended by
// admins. The legacy Vietnamese values remain valid bootstrap values.
export type MediaStatus = string;
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

export interface AIFlags {
  is_ai: boolean;
  is_internal: boolean;
  has_people: boolean;
  tag_failed: boolean;
  is_broken?: boolean;
  non_catalog?: boolean;
}

export interface AIConfidence {
  sku: number;
  brand: number;
  category: number;
  space?: number;
  status?: number;
}

export interface Dimensions {
  width: number;
  height: number;
  size_bytes: number;
}

export interface OriginInfo {
  source: string; // 'Thợ' | 'Bảo hành' | 'Upload' | 'AI'
  source_type?: string;
  project_name?: string;
  project_hint?: string;
  batch_id?: string;
  uploaded_at?: string;
  ticket_id?: string;
  uploader?: string;
  uploader_email?: string;
  batch_context?: string;
  import_batch_id?: string;
  /** URL gốc khi ảnh được import từ link trang sản phẩm (source_type 'WebFetch'). */
  source_url?: string;
}

export interface UsageRecord {
  id: string;
  date: string;
  channel: string;
  used_by: string;
  note?: string;
}

export interface CropConfig {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  is_rounded?: boolean;
  border_radius?: number;
  updated_at?: string;
  updated_by?: string;
}

/** One row of the media_asset_products <-> verity_products join (Batch 3:
 * product entity parity). Previously write-only -- populated by the DB-side
 * SKU-sync triggers in backend/migrations/0011-0013 but never read by any
 * application code. Distinct from the single legacy `sku`/`brand` fields on
 * MediaAsset: an asset can carry multiple product relations at once. */
export interface MediaAssetProductLink {
  id: string;
  product_id: string;
  code: string;
  display_name: string;
  brand: string;
  model_name?: string;
  category?: string;
  role: 'primary' | 'secondary' | 'background' | 'packaging';
  confidence: number | null;
  source: string;
  review_state: 'draft' | 'confirmed' | 'rejected';
  created_at: string;
}

export interface PublishedRendition {
  id: string;
  width: number;
  height: number;
  cdn_url: string;
  cdn_key: string;
  format: string;
  mime_type: string;
  purpose: string;
  size_bytes?: number;
  created_at?: string;
}

export interface MediaAsset {
  id: string;
  title: string;
  file_url: string;
  thumbnail_url: string;
  guide_url?: string;
  media_type: MediaType;
  duration?: string; // e.g. '0:42' for video
  
  sku: string;
  brand: string;
  category: string; // 'Ảnh thực tế' | 'Ảnh Studio' | 'Ảnh Thiết kế'
  sub_category?: string | null; // 'Công trình' | 'Showroom' | 'Hiện trường' | 'Banner' | 'Render 3D' | 'Mockup' | ...
  space?: string;   // 'Phòng khách' | 'Bếp' | 'Cửa chính' | 'Phòng ngủ' | 'Sân vườn'
  status: MediaStatus;
  permission: MediaPermission;
  
  ai_flags: AIFlags;
  ai_confidence: AIConfidence;
  suggested_caption?: string;
  promote_reference?: boolean;

  // Shared metadata defaults applied at upload time (or edited per-asset
  // afterwards) — see verity_metadata_defaults_config / finalize_upload_batch.
  author?: string;
  copyright?: string;
  credit?: string;
  description?: string;
  keywords?: string[];
  visible_text?: string[];

  phash: string;
  dimensions: Dimensions;
  origin_info: OriginInfo;
  usage_count: number;
  usages?: UsageRecord[];
  crop_configs?: Record<string, CropConfig>;
  
  created_at: string;
  updated_at?: string;
  deleted_at?: string;
  deleted_by?: string;
  needs_post_production?: boolean;
  has_open_report?: boolean;

  // Only populated on the single-asset detail fetch (GET /api/media/[id]),
  // never on the library list -- avoids an N+1 join on the grid. See
  // getNativeMediaAsset in native-media.ts.
  products?: MediaAssetProductLink[];

  // Batch 4: media_assets.publish_status is a real, actively-written column
  // (backend/app/native_gateway.py flips it to 'published'/'failed' when a
  // publish_wordpress ingest job completes) that no application code
  // surfaced before this. 'not_requested' is the default for every asset
  // that has never had a WordPress publish job queued.
  publish_status?: 'not_requested' | 'queued' | 'published' | 'failed';
  published_at?: string;

  // Universal canonical-media pipeline. The original storage key is retained
  // as provenance; consumers should use cdn_url when its versions match.
  cdn_key?: string;
  cdn_url?: string;
  canonical_slug?: string;
  canonical_version?: number;
  canonical_published_version?: number;
  canonical_published_at?: string;

  // Canonical Media Publication (Image SEO V2) renditions:
  // Only populated on single-asset detail fetch (GET /api/media/[id]).
  published_renditions?: PublishedRendition[];

  // Confirmed metadata from product intake approval workflow:
  // Only populated on single-asset detail fetch (GET /api/media/[id]).
  intake_confirmed_role?: 'HERO' | 'ANGLE' | null;
  intake_confirmed_image_category?: 'REAL' | 'STUDIO' | 'DESIGN' | null;
}

export interface ReviewQueueItem {
  id: string;
  asset: MediaAsset;
  status: ReviewStatus;
  is_duplicate: boolean;
  duplicate_similarity?: number;
  duplicate_matches?: MediaAsset[];
  user_corrections: Partial<Record<keyof MediaAsset, any>>;
  suggested_caption: string;
  sku_match?: SkuMatchResult;
  metadata_draft?: {
    visible_text?: string[];
    visible_text_confidence?: number;
    brand?: string;
    caption?: string;
    category?: string;
    keywords?: string[];
    [key: string]: any;
  };
  dedup_summary?: DedupSummary;
  created_at: string;
}

export interface SkuCandidate {
  sku: string;
  similarity: number;
  ranking_score?: number;
}

export interface SkuMatchResult {
  source?: 'embedding_reference' | 'clip_reference_embedding';
  sku?: string | null;
  confidence_band?: 'high' | 'low' | 'unmatched';
  similarity?: number;
  runner_up_similarity?: number | null;
  margin?: number | null;
  ambiguity_warning?: boolean;
  requires_reviewer_confirmation?: boolean;
  candidates?: SkuCandidate[];
  catalog_candidates?: Array<{
    sku: string;
    brand?: string;
    model_name?: string;
    display_name?: string;
    similarity?: number;
  }>;
  catalog_identity?: {
    brand?: string;
    model_name?: string;
    display_name?: string;
    catalog_sku_kind?: 'machine_code' | 'model_name' | 'missing' | 'unknown';
  };
}

export interface DedupSummary {
  phash?: Array<{ candidate_media_asset_id?: string; similarity?: number; hamming_distance?: number }>;
  scene_embedding?: Array<{ candidate_media_asset_id?: string; similarity?: number }>;
}

export interface FilterState {
  category: string[];
  space: string[];
  status: string[];
  permission: string[];
  source: string[];
  media_type: string[];
  only_ai?: boolean;
  only_people?: boolean;
  only_internal?: boolean;
  only_needs_post_production?: boolean;
  only_reported?: boolean;
}

/** Mirrors /api/media's search_meta -- a truthful report of what the R0.1
 * search-intelligence path actually did with this request, not a fabricated
 * interpretation. `used` is false whenever the intelligence path was
 * ineligible, disabled, or threw and fell back to baseline; every other
 * field is only meaningful when `used` is true. */
export interface SearchMeta {
  used: boolean;
  recovery_stage?: 'ORIGINAL_ACCENTED_LEXICAL' | 'ACCENT_FOLDED_LEXICAL' | 'BOUNDED_FUZZY_CORRECTION' | 'REVIEWED_SYNONYMS' | 'FUTURE_SEMANTIC_CHANNEL' | 'EXHAUSTED' | 'URL_EXACT_RESOLVED';
  // True only if the semantic (SigLIP2) retriever returned >= 1 validated
  // hit for this exact request -- never true while it stays inactive.
  semantic_active?: boolean;
  detected_entities?: {
    exact_sku: boolean;
    exact_brand: boolean;
    exact_brand_model: boolean;
    exact_title_phrase: boolean;
  };
}

export interface UploadItem {
  id: string;
  file: File | { name: string; size: number; type: string };
  previewUrl: string;
  stage: number; // 0: Nạp ảnh, 1: Phân tích & pHash, 2: Tự động tag, 3: Đã vào hàng chờ
  progress: number;
  is_duplicate?: boolean;
  duplicate_pct?: number;
  duplicate_preview?: string;
  dropped?: boolean;
  held?: boolean;
  error?: string;
  // 'blocked' is a real ingest_status value (media_assets.ingest_status check
  // constraint in backend/migrations/0003_native_media_schema.sql). 'unknown'
  // is client-only: the status poller lost track of the asset (it stopped
  // appearing in /api/uploads/status) and must say so rather than silently
  // reporting 'ready'.
  processing_state?: 'queued' | 'processing' | 'ready' | 'failed' | 'blocked' | 'unknown';
  // Why an in-flight asset is not progressing (for example a retryable worker
  // error such as missing Vision configuration); shown on the upload card.
  job_issue?: string;
  assetId?: string;
  reviewQueueId?: string;
}

// ─── Product intake ────────────────────────────────────────────────────────
// A product intake is deliberately separate from the established per-asset
// review queue: it carries an unapproved product identity plus the assets that
// the reviewer will decide together.
export type ProductIntakeStatus = 'draft' | 'submitted' | 'needs_changes' | 'approved' | 'rejected';
export type ProductIntakeReferenceStatus = 'none' | 'queued' | 'ready' | 'failed';
export type ProductIntakeAssetDecision = 'pending' | 'approved' | 'rejected';

export interface ProductIntakeAsset {
  media_asset_id: string;
  title?: string | null;
  /** AI caption ghi bởi vision worker; dùng để gợi ý suffix cho title, không phải identity. */
  suggested_caption?: string | null;
  thumbnail_url?: string | null;
  media_type?: MediaType | string | null;
  review_state?: string | null;
  ingest_status?: UploadItem['processing_state'] | string | null;
  ingest_error?: string | null;
  /** AI evidence only. It is never an approved product identity. */
  sku_match?: SkuMatchResult;
  reference_job_status?: string | null;
  reference_error?: string | null;
  proposed_reference?: boolean;
  /** Uploader-proposed reference labels; reviewer confirms on approval. */
  proposed_role?: string | null;
  proposed_image_category?: string | null;
  proposed_angle?: string | null;
  confirmed_role?: string | null;
  confirmed_image_category?: string | null;
  /** Link gốc nếu ảnh được import từ URL; null với ảnh tự chụp. */
  source_url?: string | null;
  /** Publish lên WordPress là job nền tách biệt khỏi việc duyệt hồ sơ này. */
  publish_status?: string | null;
  published_at?: string | null;
  decision: ProductIntakeAssetDecision;
  is_reference: boolean;
}

export interface ProductIntakePerson {
  id: string;
  name: string;
  email: string;
}

export type ProductIntakeDecisionAction = 'created' | 'submitted' | 'needs_changes' | 'approved' | 'rejected' | 'reference_retry';

export interface ProductIntakeDecision {
  action: ProductIntakeDecisionAction | string;
  note?: string | null;
  created_at?: string;
  actor?: ProductIntakePerson | null;
}

export interface ProductIntake {
  id: string;
  status: ProductIntakeStatus;
  /** Người xem hiện tại có quyền duyệt thẳng (bỏ qua bước "Gửi duyệt" riêng) hay không. */
  can_review?: boolean;
  revision: number;
  owner_id?: string | null;
  owner?: ProductIntakePerson | null;
  reviewer?: ProductIntakePerson | null;
  selected_product_id?: string | null;
  final_product_id?: string | null;
  supplement_of_intake_id?: string | null;
  selected_product?: Pick<CatalogProductSearchResult, 'id' | 'primary_sku' | 'display_name' | 'brand' | 'model_name'> | null;
  final_product?: Pick<CatalogProductSearchResult, 'id' | 'primary_sku' | 'display_name' | 'brand' | 'model_name'> | null;
  proposed_name?: string | null;
  proposed_brand?: string | null;
  proposed_model?: string | null;
  proposed_sku?: string | null;
  proposed_category?: string | null;
  proposed_space?: string | null;
  source_url?: string | null;
  notes?: string | null;
  reviewer_note?: string | null;
  final_sku?: string | null;
  reference_status: ProductIntakeReferenceStatus;
  reference_error?: string | null;
  assets: ProductIntakeAsset[];
  decisions?: ProductIntakeDecision[];
  created_at?: string;
  updated_at?: string;
  submitted_at?: string | null;
  reviewed_at?: string | null;
}

export interface CatalogProductSearchResult {
  id: string;
  primary_sku: string;
  code?: string | null;
  display_name: string;
  brand?: string | null;
  model_name?: string | null;
  category?: string | null;
  catalog_sku_kind?: string | null;
}

// ─── AI Vision (OpenAI-compatible Chat Completions Vision) ────────────────────

export type VisionDetail = 'auto' | 'low' | 'high';
export type VisionImageMode = 'url' | 'base64';

export interface AIVisionConfig {
  baseUrl: string;          // e.g. 'https://api.example.com/v1'
  apiKey: string;           // Bearer token
  model: string;            // e.g. 'gpt-4o', 'gemini-1.5-pro'
  detail: VisionDetail;     // image quality hint
  maxTokens: number;        // 256–4096
  systemPrompt: string;     // system-level instruction
}

// ─── Web Image Sources (Stock & Search Engine) ──────────────────────────────

export type WebStockProvider = 'unsplash' | 'pexels' | 'pixabay';
export type WebSearchProvider = 'googleCse' | 'braveSearch' | 'duckDuckGo';

export interface UnsplashConfig {
  enabled: boolean;
  accessKey: string;
}

export interface PexelsConfig {
  enabled: boolean;
  apiKey: string;
}

export interface PixabayConfig {
  enabled: boolean;
  apiKey: string;
}

export interface GoogleCseConfig {
  enabled: boolean;
  apiKey: string;
  cx: string;
  onlyCreativeCommons: boolean;
}

export interface BraveSearchConfig {
  enabled: boolean;
  subscriptionToken: string;
}

export interface DuckDuckGoConfig {
  enabled: boolean;
}

export interface WebImageSourceConfig {
  unsplash: UnsplashConfig;
  pexels: PexelsConfig;
  pixabay: PixabayConfig;
  googleCse: GoogleCseConfig;
  braveSearch: BraveSearchConfig;
  duckDuckGo: DuckDuckGoConfig;
}
