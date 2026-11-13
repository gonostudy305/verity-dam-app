import { NextRequest, NextResponse } from 'next/server';

import {
  areCompatibleMimeTypes,
  MAX_UPLOAD_FILES,
  validateUploadCandidate,
  ValidationError,
} from '@/lib/media-api';
import { errorResponse, ApiError } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { headR2Object, isValidStorageKey } from '@/lib/server/r2';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { assertProductIntakesEnabled, attachProductIntakeAsset } from '@/lib/server/product-intakes';
import { parsePublicHttpUrl } from '@/lib/server/url-fetch-guard';
import { isGenericOrRawTitle } from '@/lib/image-slug';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function titleFromName(name: string, fallbackTitle = '') {
  const candidate = name.replace(/\.[^.]+$/, '').trim();
  if (candidate && !isGenericOrRawTitle(candidate)) return candidate.slice(0, 255);

  // A numeric or camera-generated filename is not an asset title. Prefer a
  // user-supplied/product-backed context when available; otherwise leave the
  // title empty so review must provide an explicit human-readable value.
  const fallback = fallbackTitle.trim();
  return fallback && !isGenericOrRawTitle(fallback) ? fallback.slice(0, 255) : '';
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => {
      throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.');
    });

    if (!body || typeof body !== 'object' || !Array.isArray(body.files) || body.files.length === 0) {
      throw new ValidationError('Danh sách files upload không hợp lệ.');
    }
    if (body.files.length > MAX_UPLOAD_FILES) {
      throw new ValidationError(`Số lượng tệp tải lên vượt quá giới hạn (${MAX_UPLOAD_FILES}).`);
    }

    const context = typeof body.context === 'string' ? body.context.trim().slice(0, 2000) : null;
    const sourceType = typeof body.source_type === 'string' ? body.source_type.trim().slice(0, 50) : 'Upload';
    const projectHint = typeof body.project_hint === 'string' ? body.project_hint.trim().slice(0, 200) : null;
    const batchId = typeof body.batch_id === 'string' ? body.batch_id.trim().slice(0, 100) : null;
    const permission = body?.permission === 'internal' ? 'internal' : 'public';
    const isInternal = permission === 'internal';
    const intakeId = typeof body.intake_id === 'string' && body.intake_id.trim() ? body.intake_id.trim() : null;
    const prefillSku = typeof body.prefill_sku === 'string' && body.prefill_sku.trim() ? body.prefill_sku.trim() : null;
    if (intakeId) assertProductIntakesEnabled();
    const { user } = await requireNativeContributor();
    const uploads = body.files.map((entry: unknown) => {
      const source = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      const file = validateUploadCandidate({ name: source.fileName, size: source.sizeBytes, type: source.mimeType });
      const storagePath = typeof source.storagePath === 'string' ? source.storagePath : '';
      if (!storagePath.startsWith(`${user.id}/`) || !isValidStorageKey(storagePath)) {
        throw new ValidationError('Đường dẫn tệp upload không hợp lệ.');
      }
      // Ảnh lấy từ URL (/api/uploads/from-url/fetch) kèm theo nguồn và hash của
      // đúng bytes đã ghi lên R2; upload thường không có hai trường này.
      const sourceUrl = source.source_url == null ? null : parsePublicHttpUrl(source.source_url).toString().slice(0, 2000);
      const rawHash = typeof source.sha256 === 'string' ? source.sha256.trim().toLowerCase() : '';
      const contentHash = /^[0-9a-f]{64}$/.test(rawHash) ? rawHash : null;
      return {
        file,
        storagePath,
        sourceUrl,
        contentHash,
        proposedReference: source.proposed_reference === true,
        proposedRole: source.proposed_role,
        proposedImageCategory: source.proposed_image_category,
        proposedAngle: source.proposed_angle,
      };
    });

    const pool = requireNativeDatabase();
    const connection = await pool.connect();
    const result: Array<Record<string, unknown>> = [];
    try {
      await connection.query('BEGIN');
      let targetProduct: { id: string; primary_sku: string; display_name: string | null; model_name: string | null } | null = null;
      if (prefillSku) {
        const productCheck = await connection.query<{ id: string; primary_sku: string; display_name: string | null; model_name: string | null }>(
          `select id, primary_sku, display_name, model_name
             from public.verity_products
            where (lower(primary_sku) = lower($1) or lower(code) = lower($1))
              and lifecycle <> 'discontinued'
            limit 1`,
          [prefillSku]
        );
        if (!productCheck.rows[0]) {
          throw new ApiError(400, 'PRODUCT_SKU_INVALID', `SKU "${prefillSku}" không tồn tại hoặc đã ngừng kinh doanh.`);
        }
        targetProduct = productCheck.rows[0];
        await connection.query(`select set_config('verity.sync_actor', 'human', true)`);
        await connection.query(`select set_config('verity.sync_actor_id', $1, true)`, [user.id]);
      }

      for (const upload of uploads) {
        const object = await headR2Object(upload.storagePath, user.id);
        if (object.sizeBytes !== upload.file.sizeBytes || !areCompatibleMimeTypes(object.contentType, upload.file.mimeType)) {
          throw new ApiError(400, 'UPLOAD_METADATA_MISMATCH', 'Metadata object trên R2 không khớp request.');
        }

        const existing = await connection.query<{ id: string; queue_id: string; is_duplicate: boolean; duplicate_asset_ids: unknown }>(
          `select a.id, q.id as queue_id, q.is_duplicate, q.duplicate_asset_ids
            from public.media_assets a
             join public.review_queue q on q.media_asset_id = a.id
            where a.storage_path = $1 and a.deleted_at is null`,
          [upload.storagePath]
        );
        if (existing.rows[0]) {
          if (targetProduct) {
            await connection.query(
              `update public.media_assets
                  set sku = $2, updated_at = now()
                where id = $1 and (sku is null or sku = '')`,
              [existing.rows[0].id, targetProduct.primary_sku]
            );
          }
          if (intakeId) {
            await attachProductIntakeAsset(connection, intakeId, existing.rows[0].id, user.id, {
              proposedReference: upload.proposedReference,
              proposedRole: upload.proposedRole,
              proposedImageCategory: upload.proposedImageCategory,
              proposedAngle: upload.proposedAngle,
            });
          }
          result.push({
            media_asset_id: existing.rows[0].id,
            review_queue_id: existing.rows[0].queue_id,
            is_duplicate: existing.rows[0].is_duplicate,
            duplicate_asset_ids: existing.rows[0].duplicate_asset_ids || [],
          });
          continue;
        }

        const asset = await connection.query<{ id: string }>(
          `insert into public.media_assets
             (title, file_url, thumbnail_url, storage_path, thumbnail_path, media_type,
              permission, ai_flags, ai_confidence, dimensions, origin_info, review_state, created_by,
              content_hash, source_provider, source_file_id, sku)
           values ($1::text, $2::text, $2::text, $2::text, $2::text, $3::text, $8::text,
              jsonb_build_object('is_ai', false, 'is_internal', $9::boolean, 'has_people', false,
                                 'tag_failed', false, 'is_broken', false),
              jsonb_build_object('sku', 0, 'brand', 0, 'category', 0, 'space', 0),
              jsonb_build_object('width', 0, 'height', 0, 'size_bytes', $4::int),
              jsonb_strip_nulls(jsonb_build_object(
                'source', $10::text,
                'source_type', $10::text,
                'uploader', $5::text,
                'uploader_email', $7::text,
                'batch_context', $6::text,
                'project_hint', $11::text,
                'batch_id', $12::text,
                'source_url', $13::text,
                'uploaded_at', now()
              )),
              'pending', $5::uuid, $14::text, $15::text, $16::text, $17::text)
           on conflict (storage_path) where storage_path is not null do nothing
           returning id`,
          [titleFromName(
            upload.file.fileName,
            targetProduct?.display_name || targetProduct?.model_name || projectHint || context || ''
          ), upload.storagePath, upload.file.mediaType, upload.file.sizeBytes, user.id, context, user.email || null, permission, isInternal,
            // Ảnh lấy từ link tự khai nguồn, kể cả khi lô có trộn ảnh tự chụp.
            upload.sourceUrl ? 'WebFetch' : sourceType, projectHint, batchId,
            upload.sourceUrl, upload.contentHash, upload.sourceUrl ? 'web' : null,
            // uq_media_assets_source_file là unique toàn cục, trong khi key R2
            // lại theo từng uploader -> gắn user id vào để hai người cùng import
            // một URL không đụng constraint.
            upload.sourceUrl ? `${user.id}:${upload.sourceUrl}` : null,
            targetProduct ? targetProduct.primary_sku : null]
        );
        let assetId = asset.rows[0]?.id;
        if (!assetId) {
          const retry = await connection.query<{ id: string }>('select id from public.media_assets where storage_path = $1 and deleted_at is null', [upload.storagePath]);
          assetId = retry.rows[0]?.id;
        }
        if (!assetId) throw new ApiError(409, 'UPLOAD_FINALIZE_FAILED', 'Không thể tạo media asset.');

        if (intakeId) {
          await attachProductIntakeAsset(connection, intakeId, assetId, user.id, {
            proposedReference: upload.proposedReference,
            proposedRole: upload.proposedRole,
            proposedImageCategory: upload.proposedImageCategory,
            proposedAngle: upload.proposedAngle,
          });
        }

        // Byte-identical re-upload: the stored-bytes hash matches a live asset, so
        // flag it now instead of letting it enter the queue looking brand new.
        const duplicateIds = upload.contentHash
          ? (await connection.query<{ id: string }>(
              `select id from public.media_assets
                where content_hash = $1 and id <> $2 and deleted_at is null and review_state <> 'rejected'
                order by created_at asc limit 10`,
              [upload.contentHash, assetId]
            )).rows.map((row) => row.id)
          : [];
        const isExactDuplicate = duplicateIds.length > 0;

        const queueId = (await connection.query<{ id: string }>(
          `insert into public.review_queue (media_asset_id, status, is_duplicate, duplicate_similarity, duplicate_asset_ids)
           values ($1, 'pending', $2::boolean, $3::real, $4::jsonb)
           on conflict (media_asset_id) do update set media_asset_id = excluded.media_asset_id
           returning id`,
          [assetId, isExactDuplicate, isExactDuplicate ? 1 : 0, JSON.stringify(duplicateIds)]
        )).rows[0]?.id;
        if (!queueId) throw new ApiError(409, 'REVIEW_QUEUE_FAILED', 'Không thể tạo hàng chờ duyệt.');

        await connection.query(
          `insert into public.media_ingest_jobs
             (media_asset_id, job_kind, status, idempotency_key, payload)
           values ($1, 'analyze_image', 'queued', $2, jsonb_build_object('storage_path', $3::text))
           on conflict (idempotency_key) do nothing`,
          [assetId, `analyze_image:${assetId}`, upload.storagePath]
        );
        result.push({ media_asset_id: assetId, review_queue_id: queueId, is_duplicate: isExactDuplicate, duplicate_asset_ids: duplicateIds });
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    return NextResponse.json({ data: result });
  } catch (error) {
    return errorResponse(error);
  }
}
