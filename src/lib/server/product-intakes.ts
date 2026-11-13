import type { PoolClient } from 'pg';

import { isUuid } from '@/lib/media-api';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { ApiError, notFound } from '@/lib/server/http';

type DbRow = Record<string, any>;
type ProductIntakeStatus = 'draft' | 'submitted' | 'needs_changes' | 'approved' | 'rejected';
type ProductIntakeReferenceStatus = 'none' | 'queued' | 'ready' | 'failed';
type ProductIntakeAssetDecision = 'pending' | 'approved' | 'rejected';

export type ProductIntakeAccess = {
  userId: string;
  canReview: boolean;
};

export type ProductIntakeReferenceRole = 'HERO' | 'ANGLE';
export type ProductIntakeImageCategory = 'REAL' | 'STUDIO' | 'DESIGN';

const REFERENCE_ROLES = new Set<ProductIntakeReferenceRole>(['HERO', 'ANGLE']);
const IMAGE_CATEGORIES = new Set<ProductIntakeImageCategory>(['REAL', 'STUDIO', 'DESIGN']);

export type ProductIntakeDraftInput = {
  selectedProductId?: string | null;
  proposedName?: string;
  proposedBrand?: string;
  proposedModel?: string | null;
  proposedSku?: string | null;
  proposedCategory?: string | null;
  proposedSpace?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
};

/** Per-image labels the uploader proposes and the reviewer confirms. */
export type ProductIntakeAssetMetaInput = {
  proposedReference?: unknown;
  proposedRole?: unknown;
  proposedImageCategory?: unknown;
  proposedAngle?: unknown;
  title?: unknown;
};

export type ProductIntakeAssetDecisionInput = {
  mediaAssetId: string;
  decision: Exclude<ProductIntakeAssetDecision, 'pending'>;
  isReference?: boolean;
  role?: ProductIntakeReferenceRole | null;
  imageCategory?: ProductIntakeImageCategory | null;
};

export type ProductIntakeDecisionInput = {
  decision: Exclude<ProductIntakeStatus, 'draft' | 'submitted'>;
  expectedRevision: unknown;
  selectedProductId?: string | null;
  finalSku?: string | null;
  reviewerNote?: string | null;
  assetDecisions?: ProductIntakeAssetDecisionInput[];
};

const OPEN_STATUSES = new Set<ProductIntakeStatus>(['draft', 'submitted', 'needs_changes']);
const EDITABLE_STATUSES = new Set<ProductIntakeStatus>(['draft', 'needs_changes']);
const INTAKE_STATUSES = new Set<ProductIntakeStatus>(['draft', 'submitted', 'needs_changes', 'approved', 'rejected']);
const REFERENCE_STATUSES = new Set<ProductIntakeReferenceStatus>(['none', 'queued', 'ready', 'failed']);

export function isProductIntakesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERITY_PRODUCT_INTAKES_ENABLED === 'true';
}

export function assertProductIntakesEnabled(): void {
  if (!isProductIntakesEnabled()) {
    throw new ApiError(404, 'PRODUCT_INTAKES_DISABLED', 'Luồng tiếp nhận sản phẩm mới chưa được bật trên môi trường này.');
  }
}

function trimText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, maxLength);
  return trimmed || null;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isUuid(value)) {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', `${field} không hợp lệ.`);
  }
  return value;
}

function positiveRevision(value: unknown): number {
  const revision = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_REVISION', 'Phiên bản hồ sơ không hợp lệ.');
  }
  return revision;
}

function optionalReferenceRole(value: unknown): ProductIntakeReferenceRole | null {
  if (value === undefined || value === null || value === '') return null;
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!REFERENCE_ROLES.has(upper as ProductIntakeReferenceRole)) {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Vai trò ảnh mẫu không hợp lệ.');
  }
  return upper as ProductIntakeReferenceRole;
}

function optionalImageCategory(value: unknown): ProductIntakeImageCategory | null {
  if (value === undefined || value === null || value === '') return null;
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!IMAGE_CATEGORIES.has(upper as ProductIntakeImageCategory)) {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Loại ảnh không hợp lệ.');
  }
  return upper as ProductIntakeImageCategory;
}

function validateSourceUrl(value: unknown): string | null {
  const sourceUrl = trimText(value, 2_000);
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
  } catch {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Nguồn tham khảo phải là URL http hoặc https hợp lệ.');
  }
  return sourceUrl;
}

const DUMMY_SKU_BLACKLIST = new Set(['X', 'TEST', 'NONE', 'TEMP', 'UNKNOWN', 'DUMMY', 'NA', 'NULL', 'UNDEFINED']);
const SKU_REGEX = /^[A-Z0-9]{2,}(?:[-_.][A-Z0-9]+)*$/i;

export function assertValidSku(sku: unknown): string {
  const raw = trimText(sku, 50);
  if (!raw || raw.length < 3) {
    throw new ApiError(400, 'INVALID_SKU_FORMAT', 'Mã SKU phải có độ dài tối thiểu 3 ký tự.');
  }
  const normalized = raw.toUpperCase().replace(/\s+/g, '-');
  if (DUMMY_SKU_BLACKLIST.has(normalized)) {
    throw new ApiError(400, 'INVALID_SKU_FORMAT', `Mã SKU '${normalized}' không hợp lệ (thuộc danh sách mã thử nghiệm bị chặn).`);
  }
  if (!SKU_REGEX.test(normalized)) {
    throw new ApiError(400, 'INVALID_SKU_FORMAT', 'Mã SKU chỉ được chứa ký tự chữ cái, số và dấu gạch nối (- _ .), không được chứa khoảng trắng hoặc ký tự đặc biệt.');
  }
  return normalized;
}

/** Dùng chung bởi submitProductIntake và decideProductIntake (khi duyệt thẳng từ draft/needs_changes). */
function assertIntakeReadyToSubmit(intake: DbRow): void {
  const name = trimText(intake.proposed_name, 255);
  const brand = trimText(intake.proposed_brand, 120);
  if (!name || name.length < 3 || !brand) {
    throw new ApiError(400, 'PRODUCT_IDENTITY_INCOMPLETE', 'Cần tên sản phẩm (tối thiểu 3 ký tự) và hãng trước khi gửi duyệt.');
  }
  const sku = trimText(intake.proposed_sku, 100);
  if (!sku) {
    throw new ApiError(400, 'PRODUCT_SKU_REQUIRED', 'Cần khai báo SKU trước khi gửi duyệt.');
  }
  assertValidSku(sku);
}

function normalizeDraftInput(value: ProductIntakeDraftInput): Required<ProductIntakeDraftInput> {
  const rawSku = trimText(value.proposedSku, 100);
  const normalizedSku = rawSku ? rawSku.toUpperCase().replace(/\s+/g, '-') : null;
  return {
    selectedProductId: null,
    proposedName: trimText(value.proposedName, 255) || '',
    proposedBrand: trimText(value.proposedBrand, 120) || '',
    proposedModel: trimText(value.proposedModel, 200),
    proposedSku: normalizedSku,
    proposedCategory: trimText(value.proposedCategory, 120),
    proposedSpace: trimText(value.proposedSpace, 120),
    sourceUrl: validateSourceUrl(value.sourceUrl),
    notes: trimText(value.notes, 4_000),
  };
}

function sqlDisplayUrl(row: DbRow): string {
  const direct = typeof row.thumbnail_url === 'string' && /^https:\/\//.test(row.thumbnail_url)
    ? row.thumbnail_url
    : typeof row.file_url === 'string' && /^https:\/\//.test(row.file_url)
      ? row.file_url
      : '';
  if (direct) return direct;
  const storageKey = typeof row.thumbnail_path === 'string' && row.thumbnail_path
    ? row.thumbnail_path
    : typeof row.storage_path === 'string' ? row.storage_path : '';
  return storageKey ? `/api/r2-proxy?key=${encodeURIComponent(storageKey)}` : '';
}

function mapAsset(row: DbRow) {
  const decision = typeof row.decision === 'string' && ['pending', 'approved', 'rejected'].includes(row.decision)
    ? row.decision as ProductIntakeAssetDecision : 'pending';
  return {
    media_asset_id: String(row.media_asset_id),
    title: typeof row.title === 'string' ? row.title : '',
    suggested_caption: typeof row.suggested_caption === 'string' ? row.suggested_caption : null,
    thumbnail_url: sqlDisplayUrl(row),
    media_type: typeof row.media_type === 'string' ? row.media_type : 'photo',
    review_state: typeof row.review_state === 'string' ? row.review_state : 'pending',
    ingest_status: typeof row.ingest_status === 'string' ? row.ingest_status : 'queued',
    ingest_error: typeof row.ingest_error === 'string' ? row.ingest_error : null,
    sku_match: row.sku_match && typeof row.sku_match === 'object' ? row.sku_match : {},
    reference_job_status: typeof row.reference_job_status === 'string' ? row.reference_job_status : null,
    reference_error: typeof row.reference_error === 'string' ? row.reference_error : null,
    proposed_reference: Boolean(row.proposed_reference),
    proposed_role: typeof row.proposed_role === 'string' ? row.proposed_role : null,
    proposed_image_category: typeof row.proposed_image_category === 'string' ? row.proposed_image_category : null,
    proposed_angle: typeof row.proposed_angle === 'string' ? row.proposed_angle : null,
    confirmed_role: typeof row.confirmed_role === 'string' ? row.confirmed_role : null,
    confirmed_image_category: typeof row.confirmed_image_category === 'string' ? row.confirmed_image_category : null,
    // Có giá trị nghĩa là ảnh được import từ link, không phải ảnh tự chụp:
    // reviewer cần thấy nguồn trước khi quyết định cho publish.
    source_url: typeof row.source_url === 'string' ? row.source_url : null,
    // Publish lên WordPress là một job nền tách biệt khỏi việc duyệt hồ sơ ở
    // đây -- reviewer cần thấy trạng thái này để biết ảnh đã/sẽ công khai.
    publish_status: typeof row.publish_status === 'string' ? row.publish_status : null,
    published_at: row.published_at || null,
    decision,
    is_reference: Boolean(row.is_reference),
  };
}

function mapPerson(id: unknown, name: unknown, email: unknown): { id: string; name: string; email: string } | null {
  if (!id) return null;
  return {
    id: String(id),
    name: typeof name === 'string' && name ? name : (typeof email === 'string' ? email : ''),
    email: typeof email === 'string' ? email : '',
  };
}

function mapIntake(row: DbRow, assets: DbRow[] = [], decisions: DbRow[] = [], canReview = false) {
  const status = typeof row.status === 'string' && INTAKE_STATUSES.has(row.status as ProductIntakeStatus)
    ? row.status as ProductIntakeStatus : 'draft';
  const referenceStatus = typeof row.reference_status === 'string' && REFERENCE_STATUSES.has(row.reference_status as ProductIntakeReferenceStatus)
    ? row.reference_status as ProductIntakeReferenceStatus : 'none';
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    status,
    // Cho frontend biết user hiện tại có thể duyệt thẳng (draft/needs_changes/
    // submitted -> approved trong 1 lần gọi) hay chỉ có thể "Gửi duyệt".
    can_review: canReview,
    revision: Number(row.revision || 1),
    supplement_of_intake_id: row.supplement_of_intake_id ? String(row.supplement_of_intake_id) : null,
    selected_product_id: row.selected_product_id ? String(row.selected_product_id) : null,
    final_product_id: row.final_product_id ? String(row.final_product_id) : null,
    proposed_name: typeof row.proposed_name === 'string' ? row.proposed_name : '',
    proposed_brand: typeof row.proposed_brand === 'string' ? row.proposed_brand : '',
    proposed_model: typeof row.proposed_model === 'string' ? row.proposed_model : null,
    proposed_sku: typeof row.proposed_sku === 'string' ? row.proposed_sku : null,
    proposed_category: typeof row.proposed_category === 'string' ? row.proposed_category : null,
    proposed_space: typeof row.proposed_space === 'string' ? row.proposed_space : null,
    source_url: typeof row.source_url === 'string' ? row.source_url : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    reviewer_note: typeof row.reviewer_note === 'string' ? row.reviewer_note : null,
    final_sku: typeof row.final_sku === 'string' ? row.final_sku : null,
    reference_status: referenceStatus,
    reference_error: typeof row.reference_error === 'string' ? row.reference_error : null,
    selected_product: row.selected_product_id ? {
      id: String(row.selected_product_id),
      display_name: typeof row.selected_product_name === 'string' ? row.selected_product_name : '',
      primary_sku: typeof row.selected_product_sku === 'string' ? row.selected_product_sku : '',
      brand: typeof row.selected_product_brand === 'string' ? row.selected_product_brand : null,
      model_name: typeof row.selected_product_model === 'string' ? row.selected_product_model : null,
    } : null,
    final_product: row.final_product_id ? {
      id: String(row.final_product_id),
      display_name: typeof row.final_product_name === 'string' ? row.final_product_name : '',
      primary_sku: typeof row.final_product_sku === 'string' ? row.final_product_sku : '',
      brand: typeof row.final_product_brand === 'string' ? row.final_product_brand : null,
      model_name: typeof row.final_product_model === 'string' ? row.final_product_model : null,
    } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    submitted_at: row.submitted_at,
    reviewed_at: row.reviewed_at,
    owner: mapPerson(row.owner_id, row.owner_name, row.owner_email),
    reviewer: mapPerson(row.reviewed_by, row.reviewer_name, row.reviewer_email),
    assets: assets.map(mapAsset),
    decisions: decisions.map(mapDecision),
  };
}

async function findIntake(client: PoolClient, intakeId: string, lock = false): Promise<DbRow> {
  const result = await client.query<DbRow>(
    `select pi.*, sp.display_name as selected_product_name, sp.primary_sku as selected_product_sku,
            sp.brand as selected_product_brand, sp.model_name as selected_product_model,
            fp.display_name as final_product_name, fp.primary_sku as final_product_sku,
            fp.brand as final_product_brand, fp.model_name as final_product_model,
            ou.name as owner_name, ou.email as owner_email,
            ru.name as reviewer_name, ru.email as reviewer_email
       from public.product_intakes pi
       left join public.verity_products sp on sp.id = pi.selected_product_id
       left join public.verity_products fp on fp.id = pi.final_product_id
       left join public."user" ou on ou.id = pi.owner_id
       left join public."user" ru on ru.id = pi.reviewed_by
      where pi.id = $1${lock ? ' for update of pi' : ''}`,
    [intakeId]
  );
  const intake = result.rows[0];
  if (!intake) throw notFound('Không tìm thấy hồ sơ sản phẩm.');
  return intake;
}

async function findIntakeAssets(client: PoolClient, intakeId: string, lock = false): Promise<DbRow[]> {
  const result = await client.query<DbRow>(
    `select pia.*, a.title, a.suggested_caption, a.thumbnail_url, a.thumbnail_path, a.file_url, a.storage_path,
            a.media_type, a.review_state, a.ingest_status, a.ingest_error, q.sku_match,
            a.origin_info->>'source_url' as source_url,
            a.publish_status, a.published_at,
            reference_job.status as reference_job_status, reference_job.error_message as reference_error
       from public.product_intake_assets pia
       join public.media_assets a on a.id = pia.media_asset_id
       left join public.review_queue q on q.media_asset_id = a.id
       left join lateral (
         select j.status, j.error_message
           from public.media_ingest_jobs j
          where j.media_asset_id = a.id
            and j.job_kind = 'prepare_reference'
            and j.payload->>'product_intake_id' = pia.intake_id::text
          order by j.created_at desc
          limit 1
       ) reference_job on true
      where pia.intake_id = $1
      order by pia.created_at asc${lock ? ' for update of pia, a' : ''}`,
    [intakeId]
  );
  return result.rows;
}

function canAccess(row: DbRow, access: ProductIntakeAccess): void {
  if (access.canReview || String(row.owner_id) === access.userId) return;
  throw new ApiError(403, 'PRODUCT_INTAKE_FORBIDDEN', 'Bạn không có quyền xem hồ sơ sản phẩm này.');
}

/** Lịch sử rút gọn cho reviewer: bỏ 'updated' (mỗi lần lưu nháp đều ghi 1 dòng,
 * không phải mốc đáng xem) và chỉ giữ các chuyển trạng thái có ý nghĩa. */
async function findIntakeDecisions(client: PoolClient, intakeId: string): Promise<DbRow[]> {
  const result = await client.query<DbRow>(
    `select d.action, d.note, d.created_at, d.actor_id, u.name as actor_name, u.email as actor_email
       from public.product_intake_decisions d
       left join public."user" u on u.id = d.actor_id
      where d.intake_id = $1 and d.action <> 'updated'
      order by d.created_at asc
      limit 20`,
    [intakeId]
  );
  return result.rows;
}

function mapDecision(row: DbRow) {
  return {
    action: String(row.action),
    note: typeof row.note === 'string' ? row.note : null,
    created_at: row.created_at,
    actor: mapPerson(row.actor_id, row.actor_name, row.actor_email),
  };
}

async function recordDecision(
  client: PoolClient,
  intakeId: string,
  revision: number,
  action: 'created' | 'updated' | 'submitted' | 'needs_changes' | 'approved' | 'rejected' | 'reference_retry',
  actorId: string,
  note: string | null = null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `insert into public.product_intake_decisions (intake_id, revision, action, actor_id, note, payload)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [intakeId, revision, action, actorId, note, JSON.stringify(payload)]
  );
}

async function resolveProductForApproval(
  client: PoolClient,
  intake: DbRow,
  requestedSku: string,
): Promise<{ id: string; sku: string; brand: string; category?: string | null }> {
  const normalizedSku = assertValidSku(requestedSku);
  await client.query(`select pg_advisory_xact_lock(hashtextextended(lower($1), 0))`, [normalizedSku]);

  const existingResult = await client.query<DbRow>(
    `select id, primary_sku
       from public.verity_products
      where lifecycle <> 'discontinued'
        and (lower(primary_sku) = lower($1)
          or lower(code) = lower($1)
          or exists (select 1 from unnest(aliases) alias where lower(alias) = lower($1)))
      order by (lifecycle = 'active') desc, created_at asc
      limit 1
      for update`,
    [normalizedSku]
  );
  if (existingResult.rows[0]) {
    throw new ApiError(409, 'PRODUCT_IDENTITY_CONFLICT', `SKU '${normalizedSku}' đã tồn tại trong danh mục catalog. Để bổ sung ảnh cho sản phẩm này, vui lòng sử dụng luồng tải ảnh (/upload).`);
  }

  const displayName = trimText(intake.proposed_name, 255);
  const brand = trimText(intake.proposed_brand, 120);
  if (!displayName || displayName.length < 3 || !brand) {
    throw new ApiError(400, 'PRODUCT_IDENTITY_INCOMPLETE', 'Cần tên sản phẩm (tối thiểu 3 ký tự) và hãng trước khi tạo sản phẩm mới.');
  }
  const created = await client.query<DbRow>(
    `insert into public.verity_products
      (code, display_name, brand, model_name, category, primary_sku, lifecycle, source_system, external_id, source_payload, catalog_sku_kind)
     values ($1, $2, $3, $4, $6, $1, 'active', 'product_intake', $5,
             jsonb_build_object('product_intake_id', $5::text),
             case when $1 ~ '^[A-Za-z0-9_.\\-/]+$' then 'machine_code' else 'model_name' end)
     returning id, primary_sku, brand, category`,
    [
      normalizedSku,
      displayName,
      brand,
      trimText(intake.proposed_model, 200) || null,
      String(intake.id),
      trimText(intake.proposed_category, 120) || null,
    ]
  );
  const product = created.rows[0];
  if (!product) throw new ApiError(409, 'PRODUCT_CREATE_FAILED', 'Không thể tạo sản phẩm mới.');
  return {
    id: String(product.id),
    sku: String(product.primary_sku),
    brand: String(product.brand),
    category: product.category ? String(product.category) : null,
  };
}

export async function createProductIntake(access: ProductIntakeAccess, value: ProductIntakeDraftInput) {
  const input = normalizeDraftInput(value);
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const result = await client.query<DbRow>(
      `insert into public.product_intakes
        (owner_id, selected_product_id, proposed_name, proposed_brand, proposed_model, proposed_sku,
         proposed_category, proposed_space, source_url, notes)
       values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9)
       returning *`,
      [access.userId, input.proposedName, input.proposedBrand, input.proposedModel, input.proposedSku,
       input.proposedCategory, input.proposedSpace, input.sourceUrl, input.notes]
    );
    const intake = result.rows[0];
    await recordDecision(client, String(intake.id), Number(intake.revision), 'created', access.userId);
    await client.query('commit');
    return mapIntake(intake, [], [], access.canReview);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Start a fresh, editable intake that supplements an already-approved
 * product. The source intake is retained for auditability; no catalog metadata
 * is copied back into or changed on the existing product. */
export async function createProductIntakeSupplement(access: ProductIntakeAccess, sourceIntakeId: string) {
  if (!isUuid(sourceIntakeId)) throw notFound('Không tìm thấy hồ sơ sản phẩm.');
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const source = await findIntake(client, sourceIntakeId, true);
    canAccess(source, access);
    if (source.status !== 'approved' || !source.final_product_id || !source.final_sku) {
      throw new ApiError(409, 'PRODUCT_INTAKE_NOT_SUPPLEMENTABLE', 'Chỉ hồ sơ đã duyệt và đã chốt sản phẩm mới có thể bổ sung ảnh.');
    }
    const productResult = await client.query<DbRow>(
      `select id, display_name, brand, model_name, primary_sku, code
         from public.verity_products
        where id = $1 and lifecycle <> 'discontinued'
        for share`,
      [source.final_product_id]
    );
    const product = productResult.rows[0];
    if (!product) throw new ApiError(409, 'PRODUCT_NOT_FOUND', 'Sản phẩm đã duyệt không còn khả dụng để bổ sung ảnh.');

    const result = await client.query<DbRow>(
      `insert into public.product_intakes
        (owner_id, supplement_of_intake_id, selected_product_id, proposed_name, proposed_brand, proposed_model, proposed_sku)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning *`,
      [
        access.userId,
        sourceIntakeId,
        product.id,
        trimText(product.display_name, 255) || trimText(source.proposed_name, 255) || '',
        trimText(product.brand, 120) || trimText(source.proposed_brand, 120) || '',
        trimText(product.model_name, 200) || trimText(source.proposed_model, 200),
        trimText(product.primary_sku, 100) || trimText(product.code, 100) || trimText(source.final_sku, 100),
      ]
    );
    const intake = result.rows[0];
    await recordDecision(client, String(intake.id), Number(intake.revision), 'created', access.userId, null, {
      supplement_of_intake_id: sourceIntakeId,
      product_id: String(product.id),
    });
    await client.query('commit');
    return getProductIntake(access, String(intake.id));
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function getProductIntake(access: ProductIntakeAccess, intakeId: string) {
  if (!isUuid(intakeId)) throw notFound('Không tìm thấy hồ sơ sản phẩm.');
  const client = await requireNativeDatabase().connect();
  try {
    const intake = await findIntake(client, intakeId);
    canAccess(intake, access);
    const assets = await findIntakeAssets(client, intakeId);
    const decisions = await findIntakeDecisions(client, intakeId);
    return mapIntake(intake, assets, decisions, access.canReview);
  } finally {
    client.release();
  }
}

export async function listProductIntakes(access: ProductIntakeAccess, status?: string | null) {
  const requestedStatus = typeof status === 'string' && INTAKE_STATUSES.has(status as ProductIntakeStatus)
    ? status as ProductIntakeStatus : undefined;
  const client = await requireNativeDatabase().connect();
  try {
    const values: unknown[] = [];
    const where: string[] = [];
    if (!access.canReview) where.push(`pi.owner_id = $${values.push(access.userId)}`);
    if (requestedStatus) where.push(`pi.status = $${values.push(requestedStatus)}`);
    const result = await client.query<DbRow>(
      `select pi.*, sp.display_name as selected_product_name, sp.primary_sku as selected_product_sku,
              sp.brand as selected_product_brand, sp.model_name as selected_product_model,
              fp.display_name as final_product_name, fp.primary_sku as final_product_sku,
              fp.brand as final_product_brand, fp.model_name as final_product_model,
              ou.name as owner_name, ou.email as owner_email,
              ru.name as reviewer_name, ru.email as reviewer_email
         from public.product_intakes pi
         left join public.verity_products sp on sp.id = pi.selected_product_id
         left join public.verity_products fp on fp.id = pi.final_product_id
         left join public."user" ou on ou.id = pi.owner_id
         left join public."user" ru on ru.id = pi.reviewed_by
         ${where.length ? `where ${where.join(' and ')}` : ''}
         order by case when pi.status = 'submitted' then 0 else 1 end, pi.updated_at desc
         limit 100`,
      values
    );
    const ids = result.rows.map((row) => String(row.id));
    const assetRows = ids.length ? await client.query<DbRow>(
      `select pia.*, a.title, a.suggested_caption, a.thumbnail_url, a.thumbnail_path, a.file_url, a.storage_path,
              a.media_type, a.review_state, a.ingest_status, a.ingest_error, q.sku_match,
              a.origin_info->>'source_url' as source_url,
              a.publish_status, a.published_at,
              reference_job.status as reference_job_status, reference_job.error_message as reference_error
         from public.product_intake_assets pia
         join public.media_assets a on a.id = pia.media_asset_id
         left join public.review_queue q on q.media_asset_id = a.id
         left join lateral (
           select j.status, j.error_message
             from public.media_ingest_jobs j
            where j.media_asset_id = a.id
              and j.job_kind = 'prepare_reference'
              and j.payload->>'product_intake_id' = pia.intake_id::text
            order by j.created_at desc
            limit 1
         ) reference_job on true
        where pia.intake_id = any($1::uuid[])
        order by pia.created_at asc`,
      [ids]
    ) : { rows: [] as DbRow[] };
    const assetsByIntake = new Map<string, DbRow[]>();
    for (const asset of assetRows.rows) {
      const key = String(asset.intake_id);
      assetsByIntake.set(key, [...(assetsByIntake.get(key) || []), asset]);
    }
    const decisionRows = ids.length ? await client.query<DbRow>(
      `select d.intake_id, d.action, d.note, d.created_at, d.actor_id, u.name as actor_name, u.email as actor_email
         from public.product_intake_decisions d
         left join public."user" u on u.id = d.actor_id
        where d.intake_id = any($1::uuid[]) and d.action <> 'updated'
        order by d.created_at asc`,
      [ids]
    ) : { rows: [] as DbRow[] };
    const decisionsByIntake = new Map<string, DbRow[]>();
    for (const decision of decisionRows.rows) {
      const key = String(decision.intake_id);
      decisionsByIntake.set(key, [...(decisionsByIntake.get(key) || []), decision]);
    }
    return result.rows.map((row) => mapIntake(row, assetsByIntake.get(String(row.id)) || [], decisionsByIntake.get(String(row.id)) || [], access.canReview));
  } finally {
    client.release();
  }
}

export async function updateProductIntake(access: ProductIntakeAccess, intakeId: string, expectedRevision: unknown, value: ProductIntakeDraftInput) {
  const revision = positiveRevision(expectedRevision);
  const input = normalizeDraftInput(value);
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const intake = await findIntake(client, intakeId, true);
    canAccess(intake, access);
    if (String(intake.owner_id) !== access.userId || !EDITABLE_STATUSES.has(intake.status as ProductIntakeStatus)) {
      throw new ApiError(409, 'PRODUCT_INTAKE_LOCKED', 'Hồ sơ đã gửi duyệt hoặc đã có kết quả nên không thể chỉnh sửa.');
    }
    if (Number(intake.revision) !== revision) throw new ApiError(409, 'PRODUCT_INTAKE_STALE', 'Hồ sơ đã được thay đổi ở phiên khác. Hãy tải lại trước khi lưu.');
    const updated = await client.query<DbRow>(
      `update public.product_intakes
          set selected_product_id = null, proposed_name = $2, proposed_brand = $3, proposed_model = $4,
              proposed_sku = $5, proposed_category = $8, proposed_space = $9, source_url = $6, notes = $7,
              revision = revision + 1, updated_at = now()
        where id = $1 returning *`,
      [intakeId, input.proposedName, input.proposedBrand, input.proposedModel, input.proposedSku,
       input.sourceUrl, input.notes, input.proposedCategory, input.proposedSpace]
    );
    const row = updated.rows[0];
    await recordDecision(client, intakeId, Number(row.revision), 'updated', access.userId);
    await client.query('commit');
    return getProductIntake(access, intakeId);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export type ProductIntakeAssetAttachMeta = {
  proposedReference?: boolean;
  proposedRole?: unknown;
  proposedImageCategory?: unknown;
  proposedAngle?: unknown;
};

export async function attachProductIntakeAsset(
  client: PoolClient,
  intakeId: string,
  mediaAssetId: string,
  ownerId: string,
  meta: ProductIntakeAssetAttachMeta = {},
): Promise<void> {
  const proposedReference = meta.proposedReference === true;
  const proposedRole = optionalReferenceRole(meta.proposedRole);
  const proposedImageCategory = optionalImageCategory(meta.proposedImageCategory);
  const proposedAngle = trimText(meta.proposedAngle, 60);
  if (!isUuid(intakeId) || !isUuid(mediaAssetId)) throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Hồ sơ hoặc ảnh không hợp lệ.');
  const intake = await findIntake(client, intakeId, true);
  if (String(intake.owner_id) !== ownerId || !EDITABLE_STATUSES.has(intake.status as ProductIntakeStatus)) {
    throw new ApiError(409, 'PRODUCT_INTAKE_LOCKED', 'Chỉ có thể thêm ảnh vào hồ sơ nháp hoặc hồ sơ cần bổ sung của chính bạn.');
  }
  const asset = await client.query<DbRow>(
    `select id, review_state
       from public.media_assets
      where id = $1 and created_by = $2 and deleted_at is null
      for update`,
    [mediaAssetId, ownerId]
  );
  if (!asset.rows[0]) throw new ApiError(403, 'PRODUCT_INTAKE_ASSET_FORBIDDEN', 'Ảnh không thuộc quyền upload của bạn.');
  if (asset.rows[0].review_state !== 'pending') {
    throw new ApiError(409, 'PRODUCT_INTAKE_ASSET_ALREADY_REVIEWED', 'Không thể thêm ảnh đã được duyệt hoặc từ chối vào hồ sơ sản phẩm mới.');
  }
  const attachedElsewhere = await client.query(
    `select intake_id from public.product_intake_assets
      where media_asset_id = $1 and intake_id <> $2
      limit 1`,
    [mediaAssetId, intakeId]
  );
  if (attachedElsewhere.rows[0]) {
    throw new ApiError(409, 'PRODUCT_INTAKE_ASSET_ATTACHED', 'Ảnh này đã thuộc một hồ sơ sản phẩm khác.');
  }
  await client.query(
    `insert into public.product_intake_assets
       (intake_id, media_asset_id, proposed_reference, proposed_role, proposed_image_category, proposed_angle)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (intake_id, media_asset_id) do update
       set proposed_reference = public.product_intake_assets.proposed_reference or excluded.proposed_reference,
           proposed_role = coalesce(excluded.proposed_role, public.product_intake_assets.proposed_role),
           proposed_image_category = coalesce(excluded.proposed_image_category, public.product_intake_assets.proposed_image_category),
           proposed_angle = coalesce(excluded.proposed_angle, public.product_intake_assets.proposed_angle),
           updated_at = now()`,
    [intakeId, mediaAssetId, proposedReference, proposedRole, proposedImageCategory, proposedAngle]
  );
}

export async function setProductIntakeAssetMeta(
  access: ProductIntakeAccess,
  intakeId: string,
  mediaAssetId: string,
  meta: ProductIntakeAssetMetaInput,
) {
  if (!isUuid(intakeId) || !isUuid(mediaAssetId)) throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Hồ sơ hoặc ảnh không hợp lệ.');

  const sets: string[] = [];
  const params: unknown[] = [intakeId, mediaAssetId];
  if (meta.proposedReference !== undefined) {
    if (typeof meta.proposedReference !== 'boolean') throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Cờ ảnh mẫu không hợp lệ.');
    sets.push(`proposed_reference = $${params.push(meta.proposedReference)}`);
  }
  if (meta.proposedRole !== undefined) {
    sets.push(`proposed_role = $${params.push(optionalReferenceRole(meta.proposedRole))}`);
  }
  if (meta.proposedImageCategory !== undefined) {
    sets.push(`proposed_image_category = $${params.push(optionalImageCategory(meta.proposedImageCategory))}`);
  }
  if (meta.proposedAngle !== undefined) {
    sets.push(`proposed_angle = $${params.push(trimText(meta.proposedAngle, 60))}`);
  }
  let title: string | undefined;
  if (meta.title !== undefined) {
    title = trimText(meta.title, 255) || '';
    if (!title) throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Tiêu đề ảnh không được để trống.');
  }
  if (!sets.length && title === undefined) throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_PAYLOAD', 'Không có thông tin ảnh nào để cập nhật.');

  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const intake = await findIntake(client, intakeId, true);
    if (String(intake.owner_id) !== access.userId || !EDITABLE_STATUSES.has(intake.status as ProductIntakeStatus)) {
      throw new ApiError(409, 'PRODUCT_INTAKE_LOCKED', 'Chỉ có thể gán nhãn ảnh trong hồ sơ nháp hoặc hồ sơ cần bổ sung của chính bạn.');
    }
    const membership = await client.query(
      `select 1 from public.product_intake_assets where intake_id = $1 and media_asset_id = $2`,
      [intakeId, mediaAssetId]
    );
    if (!membership.rowCount) throw notFound('Ảnh này không thuộc hồ sơ sản phẩm.');
    if (sets.length) {
      await client.query(
        `update public.product_intake_assets
            set ${sets.join(', ')}, updated_at = now()
          where intake_id = $1 and media_asset_id = $2`,
        params
      );
    }
    if (title !== undefined) {
      await client.query(`update public.media_assets set title = $1, updated_at = now() where id = $2`, [title, mediaAssetId]);
    }
    await client.query(`update public.product_intakes set updated_at = now() where id = $1`, [intakeId]);
    await client.query('commit');
    return getProductIntake(access, intakeId);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function submitProductIntake(access: ProductIntakeAccess, intakeId: string, expectedRevision: unknown) {
  const revision = positiveRevision(expectedRevision);
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const intake = await findIntake(client, intakeId, true);
    if (String(intake.owner_id) !== access.userId) throw new ApiError(403, 'PRODUCT_INTAKE_FORBIDDEN', 'Bạn không có quyền gửi hồ sơ này.');
    if (!EDITABLE_STATUSES.has(intake.status as ProductIntakeStatus)) throw new ApiError(409, 'PRODUCT_INTAKE_LOCKED', 'Hồ sơ này không thể gửi duyệt.');
    if (Number(intake.revision) !== revision) throw new ApiError(409, 'PRODUCT_INTAKE_STALE', 'Hồ sơ đã được thay đổi ở phiên khác. Hãy tải lại trước khi gửi.');
    assertIntakeReadyToSubmit(intake);
    const assets = await findIntakeAssets(client, intakeId, true);
    if (!assets.length) throw new ApiError(400, 'PRODUCT_INTAKE_EMPTY', 'Cần tải lên ít nhất một ảnh trước khi gửi duyệt.');
    const updated = await client.query<DbRow>(
      `update public.product_intakes set status = 'submitted', revision = revision + 1, submitted_at = now(), updated_at = now()
        where id = $1 returning *`, [intakeId]
    );
    const row = updated.rows[0];
    await recordDecision(client, intakeId, Number(row.revision), 'submitted', access.userId);
    await client.query('commit');
    return getProductIntake({ ...access, canReview: false }, intakeId);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeAssetDecisions(value: ProductIntakeAssetDecisionInput[] | undefined): ProductIntakeAssetDecisionInput[] {
  if (!Array.isArray(value)) return [];
  const result: ProductIntakeAssetDecisionInput[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || !isUuid(raw.mediaAssetId) || seen.has(raw.mediaAssetId)) continue;
    if (raw.decision !== 'approved' && raw.decision !== 'rejected') continue;
    if (raw.isReference === true && raw.decision !== 'approved') continue;
    seen.add(raw.mediaAssetId);
    result.push({
      mediaAssetId: raw.mediaAssetId,
      decision: raw.decision,
      isReference: raw.isReference === true,
      role: optionalReferenceRole(raw.role),
      imageCategory: optionalImageCategory(raw.imageCategory),
    });
  }
  return result;
}

export async function decideProductIntake(access: ProductIntakeAccess, intakeId: string, value: ProductIntakeDecisionInput) {
  if (!access.canReview) throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Chỉ reviewer hoặc admin được duyệt hồ sơ sản phẩm.');
  if (!['approved', 'needs_changes', 'rejected'].includes(value.decision)) {
    throw new ApiError(400, 'INVALID_PRODUCT_INTAKE_DECISION', 'Quyết định hồ sơ không hợp lệ.');
  }
  const expectedRevision = positiveRevision(value.expectedRevision);
  const finalSku = trimText(value.finalSku, 100);
  const reviewerNote = trimText(value.reviewerNote, 4_000);
  const requestedDecisions = normalizeAssetDecisions(value.assetDecisions);
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const intake = await findIntake(client, intakeId, true);
    if (!OPEN_STATUSES.has(intake.status as ProductIntakeStatus)) throw new ApiError(409, 'PRODUCT_INTAKE_NOT_SUBMITTED', 'Chỉ hồ sơ đang mở (nháp, chờ duyệt, hoặc cần bổ sung) mới có thể xử lý.');
    if (Number(intake.revision) !== expectedRevision) throw new ApiError(409, 'PRODUCT_INTAKE_STALE', 'Hồ sơ đã được thay đổi ở phiên khác. Hãy tải lại trước khi duyệt.');

    // Cho phép reviewer-capable user duyệt thẳng từ draft/needs_changes (self-review,
    // team chỉ 1-2 admin) — orchestrate "submit" ngầm trong cùng transaction thay vì
    // bắt UI gọi /submit riêng rồi mới gọi /decision.
    if (intake.status !== 'submitted') {
      assertIntakeReadyToSubmit(intake);
      await recordDecision(client, intakeId, Number(intake.revision), 'submitted', access.userId);
    }

    const assets = await findIntakeAssets(client, intakeId, true);
    if (!assets.length) throw new ApiError(400, 'PRODUCT_INTAKE_EMPTY', 'Hồ sơ không có ảnh để duyệt.');

    if (value.decision === 'needs_changes') {
      const updated = await client.query<DbRow>(
        `update public.product_intakes
            set status = 'needs_changes', reviewer_note = $2, revision = revision + 1, reviewed_by = $3,
                reviewed_at = now(), updated_at = now()
          where id = $1 returning *`,
        [intakeId, reviewerNote, access.userId]
      );
      await recordDecision(client, intakeId, Number(updated.rows[0].revision), 'needs_changes', access.userId, reviewerNote);
      await client.query('commit');
      return getProductIntake(access, intakeId);
    }

    if (value.decision === 'rejected') {
      await client.query(`select set_config('verity.product_intake_approval', 'true', true)`);
      const assetIds = assets.map((asset) => String(asset.media_asset_id));
      await client.query(`update public.product_intake_assets set decision = 'rejected', is_reference = false, reviewed_by = $2, reviewed_at = now(), updated_at = now() where intake_id = $1`, [intakeId, access.userId]);
      await client.query(`update public.media_assets set review_state = 'rejected', updated_at = now() where id = any($1::uuid[])`, [assetIds]);
      await client.query(`update public.review_queue set status = 'rejected', reviewed_by = $2, reviewed_at = now() where media_asset_id = any($1::uuid[]) and status = 'pending'`, [assetIds, access.userId]);
      const updated = await client.query<DbRow>(
        `update public.product_intakes
            set status = 'rejected', reviewer_note = $2, revision = revision + 1, reviewed_by = $3,
                reviewed_at = now(), reference_status = 'none', reference_error = null, updated_at = now()
          where id = $1 returning *`,
        [intakeId, reviewerNote, access.userId]
      );
      await recordDecision(client, intakeId, Number(updated.rows[0].revision), 'rejected', access.userId, reviewerNote);
      await client.query('commit');
      return getProductIntake(access, intakeId);
    }

    const targetFinalSku = finalSku || trimText(intake.proposed_sku, 100);
    if (!targetFinalSku) throw new ApiError(400, 'PRODUCT_SKU_REQUIRED', 'Cần chốt SKU trước khi duyệt sản phẩm.');
    if (requestedDecisions.length !== assets.length || requestedDecisions.some((item) => !assets.some((asset) => String(asset.media_asset_id) === item.mediaAssetId))) {
      throw new ApiError(400, 'PRODUCT_INTAKE_ASSET_DECISIONS_REQUIRED', 'Cần quyết định giữ hoặc loại cho toàn bộ ảnh trong hồ sơ.');
    }
    const approved = requestedDecisions.filter((item) => item.decision === 'approved');
    if (!approved.length) throw new ApiError(400, 'PRODUCT_INTAKE_NO_APPROVED_ASSET', 'Cần giữ ít nhất một ảnh để duyệt hồ sơ.');
    const referenceIds = approved.filter((item) => item.isReference).map((item) => item.mediaAssetId);
    for (const referenceId of referenceIds) {
      const asset = assets.find((entry) => String(entry.media_asset_id) === referenceId);
      if (!asset || asset.ingest_status !== 'ready') {
        throw new ApiError(409, 'REFERENCE_ASSET_NOT_READY', 'Chỉ ảnh đã phân tích xong mới có thể làm ảnh mẫu nhận diện.');
      }
      if (!['photo', 'render', 'screenshot'].includes(String(asset.media_type))) {
        throw new ApiError(409, 'REFERENCE_ASSET_INVALID_TYPE', 'Chỉ ảnh tĩnh mới có thể làm ảnh mẫu nhận diện.');
      }
    }

    const validatedFinalSku = assertValidSku(targetFinalSku);
    const product = await resolveProductForApproval(client, intake, validatedFinalSku);
    const approvedIds = approved.map((item) => item.mediaAssetId);
    const rejectedIds = requestedDecisions.filter((item) => item.decision === 'rejected').map((item) => item.mediaAssetId);
    await client.query(`select set_config('verity.product_intake_approval', 'true', true)`);
    await client.query(`select set_config('verity.sync_actor', 'human', true)`);
    await client.query(`select set_config('verity.sync_actor_id', $1, true)`, [access.userId]);
    await client.query(`update public.product_intake_assets set decision = 'pending', is_reference = false, reviewed_by = null, reviewed_at = null where intake_id = $1`, [intakeId]);
    for (const item of requestedDecisions) {
      await client.query(
        `update public.product_intake_assets
            set decision = $3, is_reference = $4, reviewed_by = $5, reviewed_at = now(),
                confirmed_role = coalesce($6, proposed_role),
                confirmed_image_category = coalesce($7, proposed_image_category),
                updated_at = now()
          where intake_id = $1 and media_asset_id = $2`,
        [intakeId, item.mediaAssetId, item.decision, item.isReference === true, access.userId, item.role ?? null, item.imageCategory ?? null]
      );
    }
    if (approvedIds.length) {
      const targetCategory = trimText(intake.proposed_category, 120) || product.category || null;
      const targetSpace = trimText(intake.proposed_space, 120) || null;
      await client.query(
        `update public.media_assets
            set sku = $1,
                brand = $2,
                review_state = 'approved',
                category = coalesce($3, category),
                space = coalesce($4, space),
                updated_at = now()
          where id = any($5::uuid[])`,
        [product.sku, product.brand, targetCategory, targetSpace, approvedIds]
      );
      await client.query(`update public.review_queue set status = 'approved', reviewed_by = $2, reviewed_at = now() where media_asset_id = any($1::uuid[]) and status in ('pending', 'skipped')`, [approvedIds, access.userId]);
    }
    if (rejectedIds.length) {
      await client.query(`update public.media_assets set review_state = 'rejected', updated_at = now() where id = any($1::uuid[])`, [rejectedIds]);
      await client.query(`update public.review_queue set status = 'rejected', reviewed_by = $2, reviewed_at = now() where media_asset_id = any($1::uuid[]) and status in ('pending', 'skipped')`, [rejectedIds, access.userId]);
    }
    const referenceStatus: ProductIntakeReferenceStatus = referenceIds.length ? 'queued' : 'none';
    const updated = await client.query<DbRow>(
      `update public.product_intakes
          set selected_product_id = null, final_product_id = $2, final_sku = $3, status = 'approved', reviewer_note = $4,
              revision = revision + 1, reviewed_by = $5, reviewed_at = now(), reference_status = $6,
              reference_error = null, reference_updated_at = now(), updated_at = now()
        where id = $1 returning *`,
      [intakeId, product.id, product.sku, reviewerNote, access.userId, referenceStatus]
    );
    const resultingRevision = Number(updated.rows[0].revision);
    for (const assetId of referenceIds) {
      await client.query(
        `insert into public.media_ingest_jobs (media_asset_id, job_kind, idempotency_key, payload)
         values ($1::uuid, 'prepare_reference', $2, jsonb_build_object('product_intake_id', $3::text, 'asset_id', $4::text))
         on conflict (idempotency_key) do nothing`,
        [assetId, `prepare_reference:${intakeId}:${assetId}:r${resultingRevision}`, intakeId, assetId]
      );
    }
    await recordDecision(client, intakeId, resultingRevision, 'approved', access.userId, reviewerNote, { final_sku: product.sku, reference_asset_ids: referenceIds });
    await client.query('commit');
    return getProductIntake(access, intakeId);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function retryProductIntakeReference(access: ProductIntakeAccess, intakeId: string) {
  if (!access.canReview) throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Chỉ reviewer hoặc admin được thử lại ảnh mẫu.');
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const intake = await findIntake(client, intakeId, true);
    if (intake.status !== 'approved') throw new ApiError(409, 'PRODUCT_INTAKE_NOT_APPROVED', 'Chỉ hồ sơ đã duyệt mới có thể thử lại ảnh mẫu.');
    if (intake.reference_status !== 'failed') {
      throw new ApiError(409, 'PRODUCT_INTAKE_REFERENCE_NOT_FAILED', 'Chỉ có thể thử lại sau khi xử lý ảnh mẫu đã thất bại.');
    }
    const references = await client.query<DbRow>(
      `select pia.media_asset_id
         from public.product_intake_assets pia
         join public.media_assets a on a.id = pia.media_asset_id
        where pia.intake_id = $1 and pia.decision = 'approved' and pia.is_reference = true
          and a.deleted_at is null and a.review_state = 'approved' and a.ingest_status = 'ready'
        for update of pia, a`,
      [intakeId]
    );
    if (!references.rows.length) throw new ApiError(409, 'PRODUCT_INTAKE_REFERENCE_MISSING', 'Hồ sơ chưa có ảnh mẫu đã duyệt để thử lại.');
    for (const reference of references.rows) {
      const assetId = String(reference.media_asset_id);
      const restarted = await client.query(
        `update public.media_ingest_jobs
            set status = 'queued', attempts = 0, error_message = null, locked_at = null, locked_by = null,
                completed_at = null, run_after = now(), updated_at = now()
          where id = (
            select id from public.media_ingest_jobs
             where media_asset_id = $1 and job_kind = 'prepare_reference'
               and payload->>'product_intake_id' = $2
               and status = 'failed'
             order by created_at desc limit 1
          )`,
        [assetId, intakeId]
      );
      if (!restarted.rowCount) {
      await client.query(
        `insert into public.media_ingest_jobs (media_asset_id, job_kind, idempotency_key, payload)
         values ($1::uuid, 'prepare_reference', $2, jsonb_build_object('product_intake_id', $3::text, 'asset_id', $4::text))`,
        [assetId, `prepare_reference:${intakeId}:${assetId}:retry:${Date.now()}`, intakeId, assetId]
      );
      }
    }
    const updated = await client.query<DbRow>(
      `update public.product_intakes
          set reference_status = 'queued', reference_error = null, reference_updated_at = now(), updated_at = now()
        where id = $1 returning *`, [intakeId]
    );
    await recordDecision(client, intakeId, Number(updated.rows[0].revision), 'reference_retry', access.userId);
    await client.query('commit');
    return getProductIntake(access, intakeId);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export function isOpenProductIntakeStatus(status: unknown): boolean {
  return typeof status === 'string' && OPEN_STATUSES.has(status as ProductIntakeStatus);
}
