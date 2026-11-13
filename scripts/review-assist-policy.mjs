export const REVIEW_PATCH_FIELDS = [
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
];

const APPROVED_CONFIDENCE_BANDS = new Set(['high']);
const APPROVED_SKU_SOURCES = new Set(['embedding_reference', 'clip_reference_embedding']);
const BLOCKED_MEDIA_TYPES = new Set(['video']);
const KNOWN_REVIEW_FORM_KEYS = new Set([
  ...REVIEW_PATCH_FIELDS,
  'id', 'file_url', 'thumbnail_url', 'guide_url', 'media_type', 'duration', 'format', 'mime_type', 'purpose', 'size_bytes', 'sub_category',
  'ai_flags', 'ai_confidence', 'promote_reference', 'visible_text', 'phash', 'dimensions',
  'origin_info', 'usage_count', 'usages', 'crop_configs', 'created_at', 'updated_at',
  'deleted_at', 'deleted_by', 'needs_post_production', 'has_open_report', 'products',
  'publish_status', 'published_at', 'cdn_key', 'cdn_url', 'canonical_slug', 'canonical_version',
  'canonical_published_version', 'canonical_published_at', 'published_renditions',
  'intake_confirmed_role', 'intake_confirmed_image_category',
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function equalPatchValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(normalizeList(left)) === JSON.stringify(normalizeList(right));
  }
  return normalizeText(left) === normalizeText(right);
}

function addBlocker(blockers, code, detail) {
  blockers.push({ code, detail });
}

export function evaluateReviewCandidate(item, mediaInspection = {}) {
  const queueItem = asObject(item);
  const asset = asObject(queueItem.asset);
  const match = asObject(queueItem.sku_match);
  const flags = asObject(asset.ai_flags);
  const candidates = Array.isArray(match.candidates) ? match.candidates : [];
  const identity = asObject(match.catalog_identity);
  const blockers = [];

  if (queueItem.status !== 'pending') addBlocker(blockers, 'QUEUE_NOT_PENDING', 'Queue item is not pending.');
  if (asset.ingest_status !== 'ready') addBlocker(blockers, 'INGEST_NOT_READY', 'Asset ingestion is not ready.');
  if (BLOCKED_MEDIA_TYPES.has(String(asset.media_type || '').toLowerCase())) {
    addBlocker(blockers, 'NOT_STILL_IMAGE', 'Review assist only handles still images.');
  }
  if (!asset.thumbnail_url && !asset.file_url) addBlocker(blockers, 'IMAGE_URL_MISSING', 'No preview or original image URL is available.');
  if (mediaInspection.checked && !mediaInspection.ok) {
    addBlocker(blockers, 'IMAGE_FETCH_FAILED', mediaInspection.error || 'The image could not be fetched.');
  }
  if (mediaInspection.checked && !mediaInspection.decoded) {
    addBlocker(blockers, 'IMAGE_DECODE_FAILED', mediaInspection.error || 'The image could not be decoded.');
  }
  if (mediaInspection.detail_checked && !mediaInspection.detail_ok) {
    addBlocker(blockers, 'ASSET_DETAIL_FETCH_FAILED', mediaInspection.detail_error || 'The asset detail could not be fetched.');
  }
  if (mediaInspection.dimensionMismatch) {
    addBlocker(blockers, 'IMAGE_DIMENSIONS_MISMATCH', 'Decoded image dimensions disagree with stored metadata.');
  }

  if (queueItem.is_duplicate === true) addBlocker(blockers, 'DUPLICATE_FLAGGED', 'Duplicate review requires a human decision.');
  if (Number(queueItem.duplicate_similarity || 0) > 0) addBlocker(blockers, 'DUPLICATE_SIMILARITY_PRESENT', 'Duplicate similarity is present.');
  if (Array.isArray(queueItem.duplicate_matches) && queueItem.duplicate_matches.length > 0) {
    addBlocker(blockers, 'DUPLICATE_MATCHES_PRESENT', 'Duplicate candidates are present.');
  }
  if (asset.has_open_report === true) addBlocker(blockers, 'OPEN_ASSET_REPORT', 'Asset has an open report.');

  for (const [flag, code] of [
    ['has_people', 'PEOPLE_DETECTED'],
    ['is_ai', 'AI_IMAGE_FLAGGED'],
    ['is_broken', 'BROKEN_IMAGE_FLAGGED'],
    ['tag_failed', 'TAGGING_FAILED'],
    ['non_catalog', 'NON_CATALOG_ASSET'],
  ]) {
    if (flags[flag] === true) addBlocker(blockers, code, `Asset flag ${flag} is true.`);
  }
  if (asset.needs_post_production === true) addBlocker(blockers, 'POST_PRODUCTION_REQUIRED', 'Asset still requires post-production.');

  if (!APPROVED_SKU_SOURCES.has(String(match.source || ''))) addBlocker(blockers, 'SKU_SOURCE_UNTRUSTED', 'SKU evidence source is missing or unsupported.');
  if (!APPROVED_CONFIDENCE_BANDS.has(String(match.confidence_band || ''))) addBlocker(blockers, 'SKU_CONFIDENCE_NOT_HIGH', 'SKU confidence band is not explicitly high.');
  if (match.requires_reviewer_confirmation !== false) addBlocker(blockers, 'SKU_REVIEW_CONFIRMATION_REQUIRED', 'SKU matcher did not explicitly clear reviewer confirmation.');
  if (match.ambiguity_warning === true) addBlocker(blockers, 'SKU_AMBIGUOUS', 'SKU matcher marked the result ambiguous.');

  const matchedSku = normalizeText(match.sku);
  const assetSku = normalizeText(asset.sku);
  const topCandidateSku = normalizeText(candidates[0]?.sku);
  if (!matchedSku || !assetSku) addBlocker(blockers, 'SKU_MISSING', 'Both the AI match and asset SKU must be present.');
  if (matchedSku && assetSku && matchedSku !== assetSku) addBlocker(blockers, 'ASSET_SKU_MISMATCH', 'Asset SKU differs from the AI SKU evidence.');
  if (topCandidateSku && matchedSku && topCandidateSku !== matchedSku) addBlocker(blockers, 'TOP_CANDIDATE_MISMATCH', 'Top candidate differs from the selected SKU evidence.');
  if (!candidates.length) addBlocker(blockers, 'SKU_CANDIDATES_MISSING', 'No SKU candidate list is available.');
  if (!identity.brand && !identity.model_name && !identity.display_name) {
    addBlocker(blockers, 'CATALOG_IDENTITY_MISSING', 'No authoritative catalog identity is attached.');
  }
  if (['missing', 'unknown'].includes(String(identity.catalog_sku_kind || '').toLowerCase())) {
    addBlocker(blockers, 'CATALOG_IDENTITY_UNRESOLVED', 'Catalog SKU kind is unresolved.');
  }

  const similarity = Number(match.similarity);
  if (!Number.isFinite(similarity) || similarity < 0.9) addBlocker(blockers, 'SKU_SIMILARITY_TOO_LOW', 'Similarity is missing or below the conservative assist floor of 0.90.');
  const margin = Number(match.margin);
  if (!Number.isFinite(margin) || margin < 0.08) addBlocker(blockers, 'SKU_MARGIN_TOO_LOW', 'Candidate margin is missing or below the current conservative floor of 0.08.');

  return {
    eligible: blockers.length === 0,
    blockers,
    evidence: {
      queue_id: typeof queueItem.id === 'string' ? queueItem.id : null,
      asset_id: typeof asset.id === 'string' ? asset.id : null,
      sku: asset.sku || match.sku || null,
      confidence_band: match.confidence_band || null,
      similarity: Number.isFinite(similarity) ? similarity : null,
      margin: Number.isFinite(margin) ? margin : null,
      catalog_identity: identity,
      image: mediaInspection,
    },
  };
}

export function validateApprovalPayload(payload, baselineItem, decision = {}) {
  const body = asObject(payload);
  const baselineAsset = asObject(baselineItem?.asset);
  const blockers = [];

  if (body.decision !== 'approved') blockers.push('MUTATION_DECISION_NOT_APPROVED');
  if (body.replace_asset_ids && Array.isArray(body.replace_asset_ids) && body.replace_asset_ids.length > 0) blockers.push('REPLACE_ASSET_IDS_NOT_ALLOWED');
  if (body.product_links && Array.isArray(body.product_links) && body.product_links.length > 0) blockers.push('PRODUCT_LINKS_NOT_ALLOWED');
  if (body.corrections && Array.isArray(body.corrections) && body.corrections.length > 0) blockers.push('CORRECTIONS_NOT_ALLOWED');
  if (body.promote_reference === true) blockers.push('REFERENCE_PROMOTION_NOT_ALLOWED');
  if (body.non_catalog === true) blockers.push('NON_CATALOG_NOT_ALLOWED');
  if (body.needs_post_production === true) blockers.push('POST_PRODUCTION_NOT_ALLOWED');
  if (asObject(body.patch).needs_post_production === true) blockers.push('NESTED_POST_PRODUCTION_NOT_ALLOWED');

  const patch = asObject(body.patch);
  const allowedPatch = asObject(decision.allowed_patch);
  if (Object.keys(allowedPatch).length > 0) blockers.push('ALLOWED_PATCH_NOT_PERMITTED');
  for (const key of Object.keys(patch)) {
    if (!KNOWN_REVIEW_FORM_KEYS.has(key)) blockers.push(`UNKNOWN_PATCH_KEY_${key.toUpperCase()}`);
  }
  if (patch.id !== undefined && String(patch.id) !== String(baselineAsset.id)) blockers.push('PATCH_ASSET_ID_MISMATCH');
  for (const field of REVIEW_PATCH_FIELDS) {
    if (!(field in patch)) continue;
    const expected = baselineAsset[field];
    if (!equalPatchValue(patch[field], expected)) {
      blockers.push(`UNEXPECTED_PATCH_${field.toUpperCase()}`);
    }
  }

  if (decision.confirmed_sku && normalizeText(decision.confirmed_sku) !== normalizeText(baselineAsset.sku)) {
    blockers.push('CONFIRMED_SKU_CHANGED_FROM_PREFLIGHT');
  }

  return { ok: blockers.length === 0, blockers };
}

export function isSafeDecisionEntry(entry, candidate) {
  return Boolean(
    entry
    && entry.operator_confirmed === true
    && entry.visual_verdict === 'exact'
    && normalizeText(entry.confirmed_sku) === normalizeText(candidate?.asset?.sku)
    && entry.preflight_image_sha256 === candidate?.inspection?.sha256
    && entry.preflight_fingerprint === candidate?.preflight_fingerprint
    && candidate?.policy?.eligible === true
  );
}
