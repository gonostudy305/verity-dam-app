import type { Pool, PoolClient } from 'pg';
import { isUuid } from '@/lib/media-api';
import { ApiError } from './http';
import { resolveMediaUrls } from './native-media';

export const VALID_REPORT_REASONS = ['wrong_sku', 'wrong_recognition', 'wrong_url', 'other'] as const;
export type AssetReportReason = (typeof VALID_REPORT_REASONS)[number];

export const VALID_REPORT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;
export type AssetReportStatus = (typeof VALID_REPORT_STATUSES)[number];

export interface AssetReport {
  id: string;
  media_asset_id: string;
  reported_by: string;
  reported_by_name?: string | null;
  reported_by_email?: string | null;
  report_reason: AssetReportReason;
  report_note: string | null;
  status: AssetReportStatus;
  resolved_by?: string | null;
  resolved_at?: string | null;
  resolution_note?: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroupedAssetReportCard {
  media_asset_id: string;
  asset: {
    id: string;
    title: string;
    sku: string;
    thumbnail_url: string;
    file_url: string;
    needs_post_production: boolean;
  };
  open_count: number;
  latest_created_at: string;
  reports: AssetReport[];
}

export interface ListAssetReportsOptions {
  status?: string;
  reason?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Creates one or more asset reports and records corresponding audit events.
 * Executes atomically within the provided database client transaction.
 */
export async function createAssetReports(
  client: PoolClient,
  params: {
    mediaAssetIds: string[];
    reportedBy: string;
    reportReason: string;
    reportNote?: string | null;
  }
): Promise<{ count: number; reportIds: string[] }> {
  const { mediaAssetIds, reportedBy, reportReason, reportNote } = params;

  if (!VALID_REPORT_REASONS.includes(reportReason as AssetReportReason)) {
    throw new ApiError(400, 'INVALID_REPORT_REASON', 'Lý do báo lỗi không hợp lệ.');
  }

  const cleanReason = reportReason as AssetReportReason;
  const cleanNote = reportNote ? reportNote.trim().slice(0, 1000) : null;

  if (cleanReason === 'other' && (!cleanNote || cleanNote.length === 0)) {
    throw new ApiError(400, 'NOTE_REQUIRED_FOR_OTHER', 'Vui lòng nhập ghi chú chi tiết khi chọn lý do Khác.');
  }

  // Filter unique valid UUIDs and enforce max batch cap of 100
  const uniqueIds = Array.from(new Set(mediaAssetIds)).filter(isUuid);
  if (!uniqueIds.length) {
    throw new ApiError(400, 'NO_VALID_ASSET_IDS', 'Không có ID media hợp lệ để báo lỗi.');
  }

  const boundedIds = uniqueIds.slice(0, 100);

  // Insert reports
  const insertQuery = `
    INSERT INTO public.asset_reports (media_asset_id, reported_by, report_reason, report_note, status)
    SELECT unnest($1::uuid[]), $2::uuid, $3, $4, 'open'
    RETURNING id, media_asset_id
  `;
  const insertRes = await client.query<{ id: string; media_asset_id: string }>(insertQuery, [
    boundedIds,
    reportedBy,
    cleanReason,
    cleanNote,
  ]);

  const createdReportIds = insertRes.rows.map((r) => r.id);

  // Insert corresponding 'created' audit events
  if (createdReportIds.length > 0) {
    const eventQuery = `
      INSERT INTO public.asset_report_events (report_id, action, payload, actor_id)
      SELECT r.id, 'created', '{}'::jsonb, $2::uuid
      FROM unnest($1::uuid[]) AS r(id)
    `;
    await client.query(eventQuery, [createdReportIds, reportedBy]);
  }

  return { count: createdReportIds.length, reportIds: createdReportIds };
}

/**
 * Lists asset reports grouped by media asset, ordered by latest report timestamp.
 */
export async function listAssetReportsGrouped(
  pool: Pool,
  options: ListAssetReportsOptions = {}
): Promise<{ data: GroupedAssetReportCard[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, options.page || 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize || 20));
  const offset = (page - 1) * pageSize;

  const whereConditions: string[] = [];
  const queryParams: unknown[] = [];

  const filterStatus = options.status || 'open';
  if (filterStatus !== 'all') {
    if (VALID_REPORT_STATUSES.includes(filterStatus as AssetReportStatus)) {
      queryParams.push(filterStatus);
      whereConditions.push(`r.status = $${queryParams.length}`);
    } else {
      whereConditions.push(`r.status = 'open'`);
    }
  }

  if (options.reason && VALID_REPORT_REASONS.includes(options.reason as AssetReportReason)) {
    queryParams.push(options.reason);
    whereConditions.push(`r.report_reason = $${queryParams.length}`);
  }

  const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

  // 1. Get total distinct assets matching the filter
  const countQuery = `
    SELECT count(DISTINCT r.media_asset_id)::int AS total
    FROM public.asset_reports r
    ${whereSql}
  `;
  const countRes = await pool.query<{ total: number }>(countQuery, queryParams);
  const total = countRes.rows[0]?.total || 0;

  if (total === 0) {
    return { data: [], total: 0, page, pageSize };
  }

  // 2. Select paginated distinct asset groups
  const paramLimit = queryParams.push(pageSize);
  const paramOffset = queryParams.push(offset);

  const groupsQuery = `
    SELECT r.media_asset_id,
           max(r.created_at) AS latest_created_at,
           count(r.id) FILTER (WHERE r.status IN ('open', 'in_review'))::int AS open_count
    FROM public.asset_reports r
    ${whereSql}
    GROUP BY r.media_asset_id
    ORDER BY max(r.created_at) DESC
    LIMIT $${paramLimit} OFFSET $${paramOffset}
  `;
  const groupsRes = await pool.query<{
    media_asset_id: string;
    latest_created_at: string;
    open_count: number;
  }>(groupsQuery, queryParams);

  const matchedAssetIds = groupsRes.rows.map((g) => g.media_asset_id);
  if (!matchedAssetIds.length) {
    return { data: [], total, page, pageSize };
  }

  // 3. Fetch media asset details for the matched groups
  const assetsQuery = `
    SELECT a.id, a.title, a.sku, a.file_url, a.thumbnail_url, a.storage_path, a.needs_post_production
    FROM public.media_assets a
    WHERE a.id = ANY($1::uuid[]) AND a.deleted_at IS NULL
  `;
  const assetsRes = await pool.query<{
    id: string;
    title: string;
    sku: string;
    file_url: string;
    thumbnail_url: string;
    storage_path?: string;
    needs_post_production?: boolean;
  }>(assetsQuery, [matchedAssetIds]);

  const resolvedUrls = resolveMediaUrls(assetsRes.rows);
  const assetById = new Map(
    assetsRes.rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title || 'Không có tiêu đề',
        sku: row.sku || '',
        thumbnail_url: row.storage_path ? resolvedUrls.get(row.storage_path) || row.thumbnail_url || '' : row.thumbnail_url || '',
        file_url: row.storage_path ? resolvedUrls.get(row.storage_path) || row.file_url || '' : row.file_url || '',
        needs_post_production: Boolean(row.needs_post_production),
      },
    ])
  );

  // 4. Fetch all reports for the matched assets (with user info)
  const reportsQuery = `
    SELECT r.id, r.media_asset_id, r.reported_by, r.report_reason, r.report_note,
           r.status, r.resolved_by, r.resolved_at, r.resolution_note,
           r.created_at, r.updated_at,
           u.name AS reported_by_name, u.email AS reported_by_email
    FROM public.asset_reports r
    LEFT JOIN public."user" u ON u.id = r.reported_by
    WHERE r.media_asset_id = ANY($1::uuid[])
    ORDER BY r.created_at DESC
  `;
  const reportsRes = await pool.query<AssetReport & { reported_by_name?: string; reported_by_email?: string }>(reportsQuery, [matchedAssetIds]);

  const reportsByAssetId = new Map<string, AssetReport[]>();
  for (const rep of reportsRes.rows) {
    const list = reportsByAssetId.get(rep.media_asset_id) || [];
    list.push(rep);
    reportsByAssetId.set(rep.media_asset_id, list);
  }

  // 5. Assemble grouped cards in order
  const data: GroupedAssetReportCard[] = groupsRes.rows.flatMap((group) => {
    const assetMeta = assetById.get(group.media_asset_id);
    if (!assetMeta) return [];
    return [
      {
        media_asset_id: group.media_asset_id,
        asset: assetMeta,
        open_count: group.open_count,
        latest_created_at: group.latest_created_at,
        reports: reportsByAssetId.get(group.media_asset_id) || [],
      },
    ];
  });

  return { data, total, page, pageSize };
}

/**
 * Transitions reports to a new status (in_review, resolved, dismissed, or reopened to open).
 * Records an audit event for every report transitioned.
 */
export async function transitionAssetReports(
  client: PoolClient,
  params: {
    reportIds: string[];
    nextStatus: AssetReportStatus;
    actorId: string;
    resolutionNote?: string | null;
  }
): Promise<{ updatedCount: number }> {
  const { reportIds, nextStatus, actorId, resolutionNote } = params;

  if (!VALID_REPORT_STATUSES.includes(nextStatus)) {
    throw new ApiError(400, 'INVALID_STATUS', 'Trạng thái chuyển đổi không hợp lệ.');
  }

  const validIds = Array.from(new Set(reportIds)).filter(isUuid);
  if (!validIds.length) {
    return { updatedCount: 0 };
  }

  // Lock target rows
  const lockRes = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM public.asset_reports WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [validIds]
  );

  if (!lockRes.rows.length) {
    return { updatedCount: 0 };
  }

  const cleanResolutionNote = resolutionNote ? resolutionNote.trim().slice(0, 1000) : null;
  const isTerminal = nextStatus === 'resolved' || nextStatus === 'dismissed';

  const updateQuery = `
    UPDATE public.asset_reports
       SET status = $2,
           resolved_by = CASE WHEN $3 = true THEN $4::uuid ELSE NULL END,
           resolved_at = CASE WHEN $3 = true THEN now() ELSE NULL END,
           resolution_note = CASE WHEN $3 = true THEN $5 ELSE NULL END,
           updated_at = now()
     WHERE id = ANY($1::uuid[])
     RETURNING id, status
  `;
  const updateRes = await client.query<{ id: string; status: string }>(updateQuery, [
    validIds,
    nextStatus,
    isTerminal,
    actorId,
    cleanResolutionNote,
  ]);

  // Insert audit event trail for each transitioned report
  for (const row of lockRes.rows) {
    const payload = JSON.stringify({
      from: row.status,
      to: nextStatus,
      resolution_note: cleanResolutionNote,
    });
    await client.query(
      `INSERT INTO public.asset_report_events (report_id, action, payload, actor_id) VALUES ($1::uuid, $2, $3::jsonb, $4::uuid)`,
      [row.id, nextStatus, payload, actorId]
    );
  }

  return { updatedCount: updateRes.rowCount || 0 };
}

export interface MediaAssetUpdateFields {
  sku?: string | null;
  title?: string | null;
  category?: string | null;
  sub_category?: string | null;
  space?: string | null;
  needs_post_production?: boolean;
}

export interface ResolveAndFixAssetReportParams {
  mediaAssetId: string;
  reportIds?: string[];
  action: 'resolve' | 'dismiss';
  actorId: string;
  resolutionNote?: string | null;
  mediaUpdates?: MediaAssetUpdateFields;
}

/**
 * Atomically updates media asset metadata (SKU, title, category, space, post-production)
 * under 'human' sync_actor authority, and transitions related reports to resolved or dismissed.
 * Invariant: NEVER alters file_url, storage_path, or thumbnail_url to preserve SEO and prevent 404s.
 */
export async function resolveAndFixAssetReport(
  client: PoolClient,
  params: ResolveAndFixAssetReportParams
): Promise<{ updatedReportCount: number; updatedAssetId: string }> {
  const { mediaAssetId, reportIds = [], action, actorId, resolutionNote, mediaUpdates } = params;

  if (!isUuid(mediaAssetId)) {
    throw new ApiError(400, 'INVALID_MEDIA_ID', 'ID ảnh không hợp lệ.');
  }

  // 1. Establish human sync actor so trigger sync_primary_product_from_sku confirms links
  await client.query(`select set_config('verity.sync_actor', 'human', true)`);
  await client.query(`select set_config('verity.sync_actor_id', $1, true)`, [actorId]);

  // 2. Perform safe metadata update on media_assets if updates are provided and action is resolve
  if (action === 'resolve' && mediaUpdates) {
    const setClauses: string[] = ['updated_at = now()'];
    const queryParams: unknown[] = [mediaAssetId];

    if (mediaUpdates.sku !== undefined) {
      const raw = typeof mediaUpdates.sku === 'string' ? mediaUpdates.sku.trim() : '';
      const cleanSku = raw ? raw.slice(0, 100) : null;
      queryParams.push(cleanSku);
      setClauses.push(`sku = $${queryParams.length}`);
    }

    if (mediaUpdates.title !== undefined) {
      const rawTitle = typeof mediaUpdates.title === 'string' ? mediaUpdates.title.trim() : '';
      const cleanTitle = rawTitle ? rawTitle.slice(0, 255) : null;
      queryParams.push(cleanTitle);
      setClauses.push(`title = $${queryParams.length}`);
    }

    if (mediaUpdates.category !== undefined) {
      const rawCat = typeof mediaUpdates.category === 'string' ? mediaUpdates.category.trim() : '';
      const cleanCat = rawCat ? rawCat.slice(0, 100) : null;
      queryParams.push(cleanCat);
      setClauses.push(`category = $${queryParams.length}`);
    }

    if (mediaUpdates.space !== undefined) {
      const rawSpace = typeof mediaUpdates.space === 'string' ? mediaUpdates.space.trim() : '';
      const cleanSpace = rawSpace ? rawSpace.slice(0, 100) : null;
      queryParams.push(cleanSpace);
      setClauses.push(`space = $${queryParams.length}`);
    }

    if (mediaUpdates.needs_post_production !== undefined) {
      const flag = Boolean(mediaUpdates.needs_post_production);
      queryParams.push(flag);
      setClauses.push(`needs_post_production = $${queryParams.length}`);
    }

    if (setClauses.length > 1) {
      const updateAssetSql = `
        UPDATE public.media_assets
           SET ${setClauses.join(', ')}
         WHERE id = $1 AND deleted_at IS NULL
        RETURNING id
      `;
      const updateAssetRes = await client.query<{ id: string }>(updateAssetSql, queryParams);
      if (!updateAssetRes.rows.length) {
        throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Không tìm thấy ảnh hoặc ảnh đã bị xóa.');
      }
    }
  }

  // 3. Identify report IDs to transition
  let targetReportIds = reportIds.filter(isUuid);
  if (targetReportIds.length === 0) {
    const openReportsRes = await client.query<{ id: string }>(
      `SELECT id FROM public.asset_reports WHERE media_asset_id = $1 AND status IN ('open', 'in_review')`,
      [mediaAssetId]
    );
    targetReportIds = openReportsRes.rows.map((r) => r.id);
  }

  // 4. Transition reports with audit events
  const nextStatus: AssetReportStatus = action === 'dismiss' ? 'dismissed' : 'resolved';
  let updatedCount = 0;
  if (targetReportIds.length > 0) {
    const transitionResult = await transitionAssetReports(client, {
      reportIds: targetReportIds,
      nextStatus,
      actorId,
      resolutionNote: resolutionNote || (action === 'resolve' ? 'Đã chỉnh sửa thông tin qua luồng xử lý báo lỗi' : 'Bỏ qua báo lỗi'),
    });
    updatedCount = transitionResult.updatedCount;
  }

  return {
    updatedReportCount: updatedCount,
    updatedAssetId: mediaAssetId,
  };
}

