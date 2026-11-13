import { expandSearchTerms, getNativeSynonymsConfig, stripSearchStopwords } from './native-synonyms';
import { requireNativeDatabase } from './native-db';
import { ApiError, notFound } from './http';
import { mapMediaAsset, mapMediaAssetProductLink } from './media-mapper';
import { buildSearchPlan, type SearchConstraints } from './search-intelligence-plan';
import { isSearchConstraintsV1Enabled, type FlagEnvSource } from './search-constraints-flag';
import type { PoolClient } from 'pg';
import { isUuid, type MediaListParams } from '@/lib/media-api';
import { TAGGABLE_ROLE_SET, type TaggableRole } from '@/lib/product-role';
import type { CropConfig, MediaAsset, MediaAssetProductLink, PublishedRendition, ReviewQueueItem } from '@/types/media';
import { encodeReviewQueueCursor, type ReviewQueueCursor } from './review-queue-cursor';

export type Row = Record<string, any>;
export type NativeMediaListOptions = {
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  canSeeInternal?: boolean;
  excludeReported?: boolean;
  excludeUnfinished?: boolean;
};

/**
 * Dynamic CDN resolver helper:
 * Rewrites raw R2 development domains (e.g. pub-*.r2.dev) to the configured
 * custom CDN base domain (e.g. cdn.example.com) via R2_PUBLIC_BASE_URL or NEXT_PUBLIC_CDN_URL.
 */
export function normalizeCdnDomain(
  url: string,
  env: Record<string, string | undefined> = process.env
): string {
  if (!url || typeof url !== 'string') return '';
  const cdnBase = (env.R2_PUBLIC_BASE_URL || env.NEXT_PUBLIC_CDN_URL || '').trim().replace(/\/+$/, '');
  if (!cdnBase) return url;

  if (url.includes('.r2.dev/')) {
    return url.replace(/^https?:\/\/[^/]+/, cdnBase);
  }
  return url;
}

/** Exported so the R0.1 intelligence path can resolve public URLs for its
 * own (differently-selected, post-ranking) row set without duplicating
 * this logic. */
export function resolveMediaUrls(
  rows: Row[],
  env: Record<string, string | undefined> = process.env
) {
  const result = new Map<string, string>();
  for (const row of rows) {
    const storagePath = typeof row.storage_path === 'string' && row.storage_path.length > 0 ? row.storage_path : undefined;
    const thumbnailPath = typeof row.thumbnail_path === 'string' && row.thumbnail_path.length > 0 ? row.thumbnail_path : undefined;
    const isSoftDeleted = Boolean(row.deleted_at);
    const isInternalOnly = row.permission === 'internal';
    const isProtected = isSoftDeleted || isInternalOnly;

    const cdnKey = typeof row.cdn_key === 'string' ? row.cdn_key : '';
    const cdnUrl = typeof row.cdn_url === 'string' ? row.cdn_url : '';
    const canonicalVersion = Number(row.canonical_version || 0);
    const publishedVersion = Number(row.canonical_published_version || 0);

    const canonicalUrl = !isProtected
      && cdnKey.startsWith('wp-content/uploads/')
      && /^https:\/\//.test(cdnUrl)
      && canonicalVersion > 0
      && canonicalVersion === publishedVersion
      ? normalizeCdnDomain(cdnUrl, env)
      : '';

    if (storagePath) {
      let publicPath = '';
      if (!isProtected) {
        if (canonicalUrl) {
          publicPath = canonicalUrl;
        } else if (typeof row.file_url === 'string' && /^https:\/\//.test(row.file_url)) {
          publicPath = normalizeCdnDomain(row.file_url, env);
        }
      }
      if (!publicPath) {
        publicPath = `/api/r2-proxy?key=${encodeURIComponent(storagePath)}`;
      }
      result.set(storagePath, publicPath);
    }

    if (thumbnailPath) {
      let publicThumb = '';
      if (!isProtected) {
        if (canonicalUrl) {
          publicThumb = canonicalUrl;
        } else if (typeof row.thumbnail_url === 'string' && /^https:\/\//.test(row.thumbnail_url)) {
          publicThumb = normalizeCdnDomain(row.thumbnail_url, env);
        }
      }
      if (!publicThumb) {
        publicThumb = `/api/r2-proxy?key=${encodeURIComponent(thumbnailPath)}`;
      }
      result.set(thumbnailPath, publicThumb);
    }
  }
  return result;
}


function placeholders(values: unknown[], start = 1) {
  return values.map((_, index) => `$${index + start}`).join(', ');
}

/**
 * Every permission/deletion/review-state/filter predicate the baseline
 * search path applies, with NO text-search term of its own. Exported so
 * the R0.1 intelligence candidate-retrieval path
 * (native-search-intelligence.ts) can build the exact SAME eligibility
 * predicate as the baseline path -- authorization must never diverge
 * between the two search implementations (an excluded row must never
 * reach either ranker).
 */
export function buildEligibilityWhere(params: MediaListParams, values: unknown[], options: NativeMediaListOptions = {}, constraints?: SearchConstraints): string[] {
  const includeDeleted = options.includeDeleted === true;
  const deletedOnly = options.deletedOnly === true;
  const canSeeInternal = options.canSeeInternal !== false;
  const where: string[] = [];
  if (deletedOnly) where.push('a.deleted_at is not null');
  else if (!includeDeleted) where.push('a.deleted_at is null');
  if (!deletedOnly) where.push(`a.review_state = 'approved'`);
  if (!canSeeInternal) where.push(`a.permission <> 'internal'`);
  if (params.category.length) {
    const catIdx = values.push(params.category);
    where.push(`a.category = any($${catIdx}::text[])`);
  }
  if (params.space.length) { where.push(`a.space = any($${values.push(params.space)}::text[])`); }
  if (params.status.length) { where.push(`a.status = any($${values.push(params.status)}::text[])`); }
  if (params.permission.length) { where.push(`a.permission = any($${values.push(params.permission)}::text[])`); }
  if (params.source.length) { where.push(`a.brand = any($${values.push(params.source)}::text[])`); }
  if (params.mediaType.length) { where.push(`a.media_type = any($${values.push(params.mediaType)}::text[])`); }
  if (params.onlyAi) where.push(`coalesce((a.ai_flags->>'is_ai')::boolean, false)`);
  if (params.onlyPeople) where.push(`coalesce((a.ai_flags->>'has_people')::boolean, false)`);
  if (params.onlyInternal) where.push(`a.permission = 'internal'`);
  if (params.onlyNeedsPostProduction) where.push(`a.needs_post_production = true`);
  if (params.onlyReported) {
    where.push(`exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))`);
  }
  if (options.excludeReported) {
    where.push(`not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))`);
  }
  if (options.excludeUnfinished) {
    where.push(`a.needs_post_production = false`);
  }
  // Phase 1B (#44): query-derived HARD constraint, applied as a SEPARATE
  // predicate from the UI filter bag above -- `params` (MediaListParams) is
  // never mutated. Only the whitelisted human-absence negation reaches SQL;
  // it mirrors the `onlyPeople` column path with the boolean inverted and
  // binds NO parameter, so $-placeholder ordering is unaffected. If a UI
  // `onlyPeople=true` and a query `hasPeople=false` are both present, both
  // predicates AND together (a contradictory request yields an honest empty
  // result); neither overrides the other.
  if (constraints?.hasPeople === false) {
    where.push(`coalesce((a.ai_flags->>'has_people')::boolean, false) = false`);
  }
  return where;
}

/**
 * Phase 1B (#44): derive the query's HARD SearchConstraints for the BASELINE_L0
 * path. Flag-gated (default OFF): when off (or the query is empty) it returns
 * `undefined` WITHOUT calling buildSearchPlan, so the flag-off path stays
 * byte-for-byte identical to baseline (no extra CPU, no schema change).
 *
 * WHITELIST: V1 threads ONLY `hasPeople=false` (the approved human-absence
 * negation). buildSearchPlan also emits `hardConstraints.sku`, but exact-SKU
 * identity is deliberately DEFERRED to Phase 2B, where it must resolve through
 * the canonical media_asset_products -> verity_products relation (primary_sku /
 * code / aliases), NOT the legacy `media_assets.sku` column. So `sku` is dropped
 * here on purpose and never becomes a hard SQL predicate in Phase 1B.
 */
export function deriveSearchConstraints(
  query: string | undefined,
  env: FlagEnvSource = process.env,
): SearchConstraints | undefined {
  if (!isSearchConstraintsV1Enabled(env)) return undefined;
  if (!query || !query.trim()) return undefined;
  const { hardConstraints } = buildSearchPlan(query);
  if (hardConstraints.hasPeople === false) return { hasPeople: false };
  return undefined;
}

/** Build one ILIKE-OR-across-fields condition for a single search term,
 * exactly matching the column list/escaping the baseline path uses.
 * Exported so the R0.1 intelligence path's own lexical retrieval stages
 * search the identical field set with identical escaping (never a
 * divergent, independently-typed-out column list). */
export function buildIlikeTermCondition(term: string, values: unknown[]): string {
  const index = values.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
  const rawIndex = values.push(term);
  return `(a.title ilike $${index} escape '\\' or a.sku ilike $${index} escape '\\' or a.brand ilike $${index} escape '\\' or a.category ilike $${index} escape '\\' or a.space ilike $${index} escape '\\' or a.suggested_caption ilike $${index} escape '\\' or a.description ilike $${index} escape '\\' or exists (select 1 from unnest(a.keywords) keyword where keyword ilike $${index} escape '\\') or exists (select 1 from public.media_asset_products mp join public.verity_products p on p.id = mp.product_id where mp.media_asset_id = a.id and mp.review_state = 'confirmed' and (lower(p.primary_sku) = lower($${rawIndex}) or lower(p.code) = lower($${rawIndex}) or lower(p.model_name) = lower($${rawIndex}))))`;
}

function listWhere(params: MediaListParams, terms: string[], values: unknown[], options: NativeMediaListOptions = {}, constraints?: SearchConstraints) {
  const where = buildEligibilityWhere(params, values, options, constraints);
  if (terms.length) {
    const conditions = terms.map((term) => buildIlikeTermCondition(term, values));
    where.push(`(${conditions.join(' or ')})`);
  }
  return where;
}

/** Deterministic ORDER BY for the library list; the trailing a.id makes it total. */
export function libraryOrderBy(sort: MediaListParams['sort']): string {
  if (sort === 'most_used') return 'coalesce(a.usage_count, 0) desc, a.created_at desc, a.id desc';
  if (sort === 'unused') return 'coalesce(a.usage_count, 0) asc, a.created_at desc, a.id desc';
  return 'a.created_at desc, a.id desc';
}

export async function listNativeLibraryMedia(params: MediaListParams, options: NativeMediaListOptions = {}) {
  const values: unknown[] = [];
  // Strip search-intent stopwords ("ảnh", "hình", ...) before term-building --
  // see stripSearchStopwords in native-synonyms.ts. deriveSearchConstraints
  // below intentionally keeps reading the ORIGINAL params.query: it derives
  // hard constraints from the whole phrase's intent (Phase 1B, flag-gated),
  // an unrelated concern from the literal-substring lexical match built here.
  const searchText = params.query ? stripSearchStopwords(params.query) : '';
  const synonyms = searchText ? await getNativeSynonymsConfig() : [];
  const terms = searchText ? expandSearchTerms(searchText, synonyms) : [];
  // Phase 1B (#44): flag-gated; returns undefined (no-op, identical baseline SQL)
  // unless VERITY_SEARCH_CONSTRAINTS_V1_ENABLED='true' AND the query yields a
  // whitelisted hard constraint (hasPeople=false).
  const constraints = deriveSearchConstraints(params.query);
  const where = listWhere(params, terms, values, options, constraints);
  // Every sort ends in a unique tie-breaker (a.id). Without it, rows that share
  // usage_count/created_at come back in arbitrary order, so offset pagination
  // can repeat or skip assets between pages and "Dùng nhiều"/"Chưa dùng" look identical.
  const order = libraryOrderBy(params.sort);
  const offset = (params.page - 1) * params.pageSize;
  const limitIndex = values.push(params.pageSize);
  const offsetIndex = values.push(offset);
  const query = `
    select a.*,
      exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report,
      coalesce((select jsonb_agg(u order by u.used_at desc) from public.media_usages u where u.media_asset_id = a.id), '[]'::jsonb) as media_usages
    from public.media_assets a where ${where.join(' and ')} order by ${order} limit $${limitIndex} offset $${offsetIndex}`;
  const countQuery = `select count(*)::int as count from public.media_assets a where ${where.join(' and ')}`;
  const pool = requireNativeDatabase();
  const [data, count] = await Promise.all([pool.query<Row>(query, values), pool.query<{ count: number }>(countQuery, values.slice(0, -2))]);
  const urls = resolveMediaUrls(data.rows);
  return { data: data.rows.map((row) => mapMediaAsset(row, urls)), total: count.rows[0]?.count || 0 };
}

/** Batch 3: the media_asset_products <-> verity_products relation was
 * previously write-only -- kept in sync by the DB-side triggers in
 * 0011_media_asset_product_sku_sync.sql (and hardened in 0012/0013), but no
 * application code ever read it back. Returns every link regardless of
 * role/review_state (including rejected) so the Detail Drawer can show the
 * full history, primary-and-not-rejected first. Only called from the
 * single-asset detail fetch below -- never from the library list, to avoid
 * an N+1 join on the grid. */
export async function listMediaAssetProducts(mediaAssetId: string): Promise<MediaAssetProductLink[]> {
  const pool = requireNativeDatabase();
  const result = await pool.query<Row>(
    `select mp.id, mp.product_id, mp.role, mp.confidence, mp.source, mp.review_state, mp.created_at,
            p.code, p.display_name, p.brand, p.model_name, p.category
       from public.media_asset_products mp
       join public.verity_products p on p.id = mp.product_id
      where mp.media_asset_id = $1
      order by (mp.role = 'primary' and mp.review_state <> 'rejected') desc,
               (mp.review_state = 'rejected') asc,
               mp.confidence desc nulls last,
               mp.created_at asc`,
    [mediaAssetId]
  );
  return result.rows.map((row) => mapMediaAssetProductLink(row));
}

export interface AttachMediaAssetProductInput {
  mediaAssetId: string;
  sku: string;
  role?: string;
  createdBy?: string | null;
}

/** Phase 02: attach a non-primary product link to a media asset by SKU.
 * Primary product identity remains exclusively owned by media_assets.sku
 * and the 0011 DB triggers -- role='primary' is refused.
 * If externalClient is provided, it runs within the caller's transaction
 * (e.g. review decision route in Phase 03) without managing begin/commit. */
export async function attachMediaAssetProduct(
  input: AttachMediaAssetProductInput,
  externalClient?: PoolClient
): Promise<MediaAssetProductLink> {
  const mediaAssetId = input.mediaAssetId;
  if (!isUuid(mediaAssetId)) {
    throw new ApiError(400, 'INVALID_ID', 'ID không hợp lệ.');
  }

  const cleanSku = typeof input.sku === 'string' ? input.sku.trim() : '';
  if (!cleanSku) {
    throw new ApiError(400, 'INVALID_SKU', 'SKU không được để trống.');
  }
  const boundedSku = cleanSku.slice(0, 100);

  const rawRole = input.role?.trim() || 'secondary';
  if (rawRole === 'primary') {
    throw new ApiError(
      400,
      'PRIMARY_ROLE_NOT_ALLOWED',
      'Không thể gán sản phẩm chính qua endpoint này. Vui lòng cập nhật trường SKU của ảnh.'
    );
  }
  if (!TAGGABLE_ROLE_SET.has(rawRole)) {
    throw new ApiError(
      400,
      'INVALID_ROLE',
      'Vai trò không hợp lệ. Chỉ chấp nhận secondary, background, packaging.'
    );
  }
  const finalRole = rawRole as TaggableRole;

  const runWithClient = async (client: PoolClient): Promise<MediaAssetProductLink> => {
    // 1. Liveness guard: soft-deleted or rejected assets cannot have new links attached
    const assetCheck = await client.query<{ id: string }>(
      `select id from public.media_assets where id = $1 and deleted_at is null and review_state <> 'rejected'`,
      [mediaAssetId]
    );
    if (!assetCheck.rows[0]) {
      throw notFound('Không tìm thấy hình ảnh hoặc hình ảnh đã bị xóa/từ chối.');
    }

    // 2. Alias-aware product resolution mirroring 0011_media_asset_product_sku_sync.sql:207-214
    // Refuse SKUs that do not resolve to an existing verity_products row (no draft auto-creation)
    const productResult = await client.query<Row>(
      `select id, code, display_name, brand, model_name, category
         from public.verity_products
        where lifecycle <> 'discontinued'
          and (lower(primary_sku) = lower($1)
               or lower(code) = lower($1)
               or exists (select 1 from unnest(aliases) alias where lower(alias) = lower($1)))
        order by (lifecycle = 'active') desc, created_at asc
        limit 1`,
      [boundedSku]
    );
    const product = productResult.rows[0];
    if (!product) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'SKU chưa có trong danh mục sản phẩm.');
    }

    // 3. Insert link: human source, confirmed state, returning joined product fields
    const returningFields = `returning id, product_id, role, confidence, source, review_state, created_at,
          (select code from public.verity_products p where p.id = product_id) as code,
          (select display_name from public.verity_products p where p.id = product_id) as display_name,
          (select brand from public.verity_products p where p.id = product_id) as brand,
          (select model_name from public.verity_products p where p.id = product_id) as model_name,
          (select category from public.verity_products p where p.id = product_id) as category`;

    const insertResult = await client.query<Row>(
      `insert into public.media_asset_products
         (media_asset_id, product_id, role, confidence, source, review_state, created_by)
       values
         ($1, $2, $3, null, 'human', 'confirmed', $4)
       on conflict (media_asset_id, product_id) do nothing
       ${returningFields}`,
      [mediaAssetId, product.id, finalRole, input.createdBy ?? null]
    );

    if (insertResult.rows[0]) {
      return mapMediaAssetProductLink(insertResult.rows[0]);
    }

    // 4. On conflict (already linked), select existing link and raise 409
    const existing = await client.query<Row>(
      `select mp.id, mp.product_id, mp.role, mp.confidence, mp.source, mp.review_state, mp.created_at,
              p.code, p.display_name, p.brand, p.model_name, p.category
         from public.media_asset_products mp
         join public.verity_products p on p.id = mp.product_id
        where mp.media_asset_id = $1 and mp.product_id = $2`,
      [mediaAssetId, product.id]
    );
    const existingLink = existing.rows[0] ? mapMediaAssetProductLink(existing.rows[0]) : undefined;
    throw new ApiError(409, 'PRODUCT_ALREADY_LINKED', 'Sản phẩm này đã được liên kết với hình ảnh.', { link: existingLink });
  };

  if (externalClient) {
    return runWithClient(externalClient);
  }

  const pool = requireNativeDatabase();
  const internalClient = await pool.connect();
  try {
    await internalClient.query('begin');
    const result = await runWithClient(internalClient);
    await internalClient.query('commit');
    return result;
  } catch (error) {
    await internalClient.query('rollback');
    throw error;
  } finally {
    internalClient.release();
  }
}

export async function getNativeMediaAsset(id: string, canSeePending = false, includeDeleted = false, canSeeInternal = true) {
  const pool = requireNativeDatabase();
  const result = await pool.query<Row>(
    `select a.*,
       exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report,
       coalesce((select jsonb_agg(u order by u.used_at desc) from public.media_usages u where u.media_asset_id = a.id), '[]'::jsonb) as media_usages,
       coalesce((
         select jsonb_agg(
           jsonb_build_object(
             'id', r.id,
             'width', r.width,
             'height', r.height,
             'cdn_url', r.cdn_url,
             'cdn_key', r.cdn_key,
             'format', r.format,
             'mime_type', r.mime_type,
             'purpose', r.purpose,
             'size_bytes', r.size_bytes,
             'created_at', r.created_at
           ) order by r.width asc
         )
         from public.media_renditions r
         where r.media_asset_id = a.id
       ), '[]'::jsonb) as published_renditions,
        pia.confirmed_role as intake_confirmed_role,
        pia.confirmed_image_category as intake_confirmed_image_category
      from public.media_assets a
      left join public.product_intake_assets pia on pia.media_asset_id = a.id and pia.decision = 'approved'
      where a.id = $1
       and ($3::boolean or a.deleted_at is null)
       and ($3::boolean or a.review_state <> 'rejected')
       and ($3::boolean or a.review_state = 'approved' or $2::boolean)
       and ($4::boolean or a.permission <> 'internal') limit 1`, [id, canSeePending, includeDeleted, canSeeInternal]
  );
  if (!result.rows[0]) throw notFound();
  const urls = resolveMediaUrls(result.rows);
  const asset = mapMediaAsset(result.rows[0], urls);
  const products = await listMediaAssetProducts(id);
  const rawRenditions: any[] = Array.isArray(result.rows[0].published_renditions) ? result.rows[0].published_renditions : [];
  const published_renditions: PublishedRendition[] = rawRenditions.map((r: any) => ({
    id: String(r.id || ''),
    width: Number(r.width || 0),
    height: Number(r.height || 0),
    cdn_url: String(r.cdn_url || ''),
    cdn_key: String(r.cdn_key || ''),
    format: String(r.format || ''),
    mime_type: String(r.mime_type || ''),
    purpose: String(r.purpose || ''),
    size_bytes: r.size_bytes != null ? Number(r.size_bytes) : undefined,
    created_at: r.created_at ? String(r.created_at) : undefined,
  }));
  const intake_confirmed_role = (result.rows[0].intake_confirmed_role as MediaAsset['intake_confirmed_role']) || null;
  const intake_confirmed_image_category = (result.rows[0].intake_confirmed_image_category as MediaAsset['intake_confirmed_image_category']) || null;
  return { ...asset, products, published_renditions, intake_confirmed_role, intake_confirmed_image_category };
}

/** 'pending' is the main review queue; 'skipped' is the "để sau" (deferred)
 * list -- both are real, persisted review_queue.status values, never a
 * client-only concept. */
export async function listNativePendingReviewItems(limit = 50, cursor: ReviewQueueCursor | null = null, status: 'pending' | 'skipped' = 'pending') {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const boundedStatus = status === 'skipped' ? 'skipped' : 'pending';
  const pool = requireNativeDatabase();
  const queue = await pool.query<Row>(
    `with eligible as (
       select q.*, row_to_json(a) as media_asset,
         coalesce((select jsonb_agg(u order by u.used_at desc) from public.media_usages u where u.media_asset_id = a.id), '[]'::jsonb) as media_usages,
         count(*) over()::int as total_count
       from public.review_queue q join public.media_assets a on a.id = q.media_asset_id
       where q.status = $2 and a.deleted_at is null and a.ingest_status = 'ready'
         and not exists (
           select 1
           from public.product_intake_assets pia
           join public.product_intakes pi on pi.id = pia.intake_id
           where pia.media_asset_id = a.id
             and pi.status in ('draft', 'submitted', 'needs_changes')
         )
     )
     select * from eligible
     where ($3::timestamptz is null or (created_at, id) > ($3::timestamptz, $4::uuid))
      order by created_at asc, id asc
      limit $1`, [
        boundedLimit + 1,
        boundedStatus,
        cursor?.createdAt
          ? (() => {
              const d = new Date(cursor.createdAt);
              return Number.isNaN(d.getTime()) ? null : d.toISOString();
            })()
          : null,
        cursor?.id ?? null,
      ]
  );
  const hasMore = queue.rows.length > boundedLimit;
  const pageRows = queue.rows.slice(0, boundedLimit);
  const total = Number(pageRows[0]?.total_count || 0);
  const lastRow = pageRows[pageRows.length - 1];
  const lastRowCreatedAt = lastRow?.created_at
    ? (lastRow.created_at instanceof Date
        ? lastRow.created_at.toISOString()
        : (() => {
            const d = new Date(String(lastRow.created_at));
            return Number.isNaN(d.getTime()) ? String(lastRow.created_at) : d.toISOString();
          })())
    : null;
  const nextCursor = hasMore && lastRowCreatedAt && lastRow?.id
    ? encodeReviewQueueCursor({ createdAt: lastRowCreatedAt, id: String(lastRow.id) })
    : null;
  const assetRows = pageRows.map((row) => ({ ...(row.media_asset || {}), media_usages: row.media_usages }));
  const duplicateIds = [...new Set(pageRows.flatMap((row) => Array.isArray(row.duplicate_asset_ids) ? row.duplicate_asset_ids.filter((id: unknown): id is string => typeof id === 'string') : []))];
  const duplicates = duplicateIds.length ? await pool.query<Row>(
    `select a.*, coalesce((select jsonb_agg(u order by u.used_at desc) from public.media_usages u where u.media_asset_id = a.id), '[]'::jsonb) as media_usages
     from public.media_assets a where a.id = any($1::uuid[]) and a.deleted_at is null and a.review_state <> 'rejected'`, [duplicateIds]
  ) : { rows: [] as Row[] };
  const urls = resolveMediaUrls([...assetRows, ...duplicates.rows]);
  const duplicateById = new Map(duplicates.rows.map((row) => [row.id, mapMediaAsset(row, urls)]));
  const data: ReviewQueueItem[] = pageRows.flatMap((row) => {
    const assetRow = { ...(row.media_asset || {}), media_usages: row.media_usages };
    if (!assetRow.id) return [];
    return [{
      id: row.id,
      asset: mapMediaAsset(assetRow, urls),
      status: row.status,
      is_duplicate: Boolean(row.is_duplicate),
      duplicate_similarity: Number(row.duplicate_similarity || 0),
      duplicate_matches: Array.isArray(row.duplicate_asset_ids)
        ? row.duplicate_asset_ids.map((id: string) => duplicateById.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item))
        : [],
      user_corrections: row.user_corrections || {},
      suggested_caption: assetRow.suggested_caption || '',
      sku_match: row.sku_match || {},
      metadata_draft: row.metadata_draft || {},
      dedup_summary: row.dedup_summary || {},
      created_at: row.created_at,
    } satisfies ReviewQueueItem];
  });
  return { data, total, nextCursor, hasMore };
}

export async function saveNativeMediaCropConfig(mediaAssetId: string, presetId: string, crop: CropConfig, updatedBy: string) {
  const coordinates = [crop.x, crop.y, crop.width, crop.height];
  if (!['1:1', '9:16', '16:9', '4:5', 'free'].includes(presetId) || coordinates.some((value) => !Number.isFinite(value)) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 100_000_000 || crop.y + crop.height > 100_000_000) {
    throw new ApiError(400, 'INVALID_CROP_PAYLOAD', 'Dá»¯ liá»‡u cáº¯u hÃ¬nh cáº¯t áº£nh khÃ´ng há»£p lá»‡.');
  }
  const pool = requireNativeDatabase();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const row = await client.query<Row>('select id, dimensions, coalesce(origin_info, \'{}\'::jsonb) as origin_info from public.media_assets where id = $1 and deleted_at is null for update', [mediaAssetId]);
    if (!row.rows[0]) throw notFound();
    const dimensions = row.rows[0].dimensions || {};
    const width = Number(dimensions.width || 0);
    const height = Number(dimensions.height || 0);
    if (width > 0 && height > 0 && (crop.x + crop.width > width || crop.y + crop.height > height)) {
      throw new ApiError(400, 'INVALID_CROP_BOUNDS', 'Vùng crop phải nằm trong kích thước ảnh gốc.');
    }
    const current = row.rows[0].origin_info?.crop_configs && typeof row.rows[0].origin_info.crop_configs === 'object' ? row.rows[0].origin_info.crop_configs : {};
    const next = { ...current, [presetId]: { ...crop, updated_at: new Date().toISOString(), updated_by: updatedBy } };
    await client.query(`update public.media_assets set origin_info = jsonb_set(coalesce(origin_info, '{}'::jsonb), '{crop_configs}', $2::jsonb, true), updated_at = now() where id = $1 and deleted_at is null`, [mediaAssetId, JSON.stringify(next)]);
    await client.query('commit');
    return next;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Resolves a media asset ID from any image URL, CDN key, storage path, canonical slug,
 * or original product source URL.
 * Handles:
 * - WordPress rendition URLs: https://assets.verity.internal/wp-content/uploads/2026/09/slug-hash-1600x900.webp
 * - Relative WordPress paths: /wp-content/uploads/2026/09/slug-hash-1600x900.webp
 * - Cloudflare R2 URLs: https://pub-xxx.r2.dev/media/... or https://assets.verity.internal/canonical/...
 * - Storage paths: media/2026/09/xyz.webp
 * - Canonical slugs: verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien
 * - Raw filenames: VERITY_ROVER_Q_REVO.webp
 * - Product source URLs: https://camera-store.example.com/...
 */
export async function findMediaAssetIdByUrlOrPath(
  rawInput: string,
  poolOverride?: { query: (...args: any[]) => Promise<any> }
): Promise<string | null> {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // Direct UUID check
  if (isUuid(trimmed)) return trimmed;

  const pool = poolOverride || requireNativeDatabase();

  // Strip protocol, host, query params, and leading slash for relative key comparisons
  const withoutQuery = trimmed.split(/[?#]/)[0];
  let pathname = withoutQuery;
  try {
    if (withoutQuery.startsWith('http://') || withoutQuery.startsWith('https://')) {
      const parsedUrl = new URL(withoutQuery);
      pathname = parsedUrl.pathname;
    }
  } catch {
    // Keep pathname as withoutQuery
  }

  const cleanPath = pathname.replace(/^\/+/, '');
  const filename = cleanPath.split('/').pop() || '';
  const filenameWithoutExt = filename.replace(/\.[^.]+$/, '');

  // Rendition patterns:
  // e.g. "verity-d1pro-banner-marketing-cua-chinh-khoa-cua-da-ban-giao-hoan-thien-04365279a52dee9f-1600x900"
  // 1) Strip width x height dimension suffix: e.g. "-1600x900" or "-800w"
  const withoutDimension = filenameWithoutExt.replace(/-(?:\d+x\d+|\d+w)$/, '');

  // 2) Extract 16-hex hash if present: e.g. "-04365279a52dee9f"
  let extractedHash: string | null = null;
  let canonicalSlugCandidate: string = withoutDimension;
  const hashMatch = withoutDimension.match(/-([0-9a-f]{16})$/i);
  if (hashMatch) {
    extractedHash = hashMatch[1];
    canonicalSlugCandidate = withoutDimension.slice(0, -17);
  }

  // Execute prioritized, indexed lookup
  const query = `
    with matched_rendition as (
      select r.media_asset_id, 1 as priority
      from public.media_renditions r
      where r.cdn_url = $1
         or r.cdn_key = $2
         or r.cdn_key = $3
      limit 1
    ),
    matched_asset_exact as (
      select a.id as media_asset_id, 2 as priority
      from public.media_assets a
      where a.cdn_url = $1
         or a.file_url = $1
         or a.thumbnail_url = $1
         or a.storage_path = $2
         or a.storage_path = $3
         or a.cdn_key = $2
         or a.cdn_key = $3
      limit 1
    ),
    matched_slug as (
      select a.id as media_asset_id, 3 as priority
      from public.media_assets a
      where a.canonical_slug = $4
         or a.canonical_slug = $5
      limit 1
    ),
    matched_hash as (
      select a.id as media_asset_id, 4 as priority
      from public.media_assets a
      where $6::text is not null
        and (
          a.cdn_key ilike '%' || $6 || '%'
          or a.storage_path ilike '%' || $6 || '%'
        )
      limit 1
    ),
    matched_filename as (
      select a.id as media_asset_id, 5 as priority
      from public.media_assets a
      where $7::text <> ''
        and (
          a.storage_path ilike '%' || $7
          or a.cdn_key ilike '%' || $7
        )
      limit 1
    ),
    matched_source as (
      select a.id as media_asset_id, 6 as priority
      from public.media_assets a
      where a.origin_info->>'source_url' = $1
      limit 1
    ),
    combined as (
      select * from matched_rendition
      union all
      select * from matched_asset_exact
      union all
      select * from matched_slug
      union all
      select * from matched_hash
      union all
      select * from matched_filename
      union all
      select * from matched_source
    )
    select media_asset_id
    from combined
    order by priority asc
    limit 1;
  `;

  const result = await pool.query<{ media_asset_id: string }>(query, [
    withoutQuery,           // $1: full URL without query params
    cleanPath,              // $2: relative path without leading slash
    pathname,               // $3: pathname with leading slash
    canonicalSlugCandidate, // $4: slug with hash/dim stripped
    withoutDimension,       // $5: slug without dim
    extractedHash,          // $6: 16-hex hash or null
    filename,               // $7: filename
  ]);

  return result.rows[0]?.media_asset_id || null;
}

export async function resolveNativeMediaAsset(
  rawInput: string,
  canSeePending = false,
  includeDeleted = false,
  canSeeInternal = true
): Promise<MediaAsset | null> {
  const assetId = await findMediaAssetIdByUrlOrPath(rawInput);
  if (!assetId) return null;
  try {
    return await getNativeMediaAsset(assetId, canSeePending, includeDeleted, canSeeInternal);
  } catch (err) {
    return null;
  }
}

