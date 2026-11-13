import { NextRequest, NextResponse } from 'next/server';

import { isUuid, parseReviewDecision, sanitizeReviewCorrections, sanitizeReviewPatch, sanitizeReviewNonCatalog, sanitizeReviewPromoteReference, sanitizeReviewNeedsPostProduction, sanitizeReviewProductLinks, ValidationError } from '@/lib/media-api';
import { resolveSkuContext, shouldPromoteToReferenceCorpus } from '@/lib/sku-context';
import { resolveReferenceRole } from '@/lib/reference-role';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { getSharedMetadataDefaults } from '@/lib/server/metadata-defaults';
import { attachMediaAssetProduct } from '@/lib/server/native-media';
import { isGenericOrRawTitle } from '@/lib/image-slug';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, 'INVALID_ID', 'ID hàng chờ không hợp lệ.');
    const body = await request.json().catch(() => { throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.'); });
    const decision = parseReviewDecision(body?.decision);
    const patch = sanitizeReviewPatch(body?.patch);
    const corrections = sanitizeReviewCorrections(body?.corrections);
    const nonCatalog = sanitizeReviewNonCatalog(body?.non_catalog);
    const promoteReference = sanitizeReviewPromoteReference(body?.promote_reference);
    const needsPostProduction = sanitizeReviewNeedsPostProduction(body?.needs_post_production ?? (body?.patch as Record<string, unknown> | undefined)?.needs_post_production);
    const productLinks = sanitizeReviewProductLinks(body?.product_links);
    const replaceAssetIds = Array.isArray(body?.replace_asset_ids)
      ? (body.replace_asset_ids as unknown[]).filter((item): item is string => typeof item === 'string' && isUuid(item))
      : [];
    const { user } = await requireNativeReviewer();

    // "Để sau" (skipped) is a real, persisted review_queue.status -- it must
    // never touch media_assets (no review_state/patch/correction-log writes).
    // It only records that this reviewer deferred the item so it can be
    // reopened into the pending queue later via the /reopen route.
    if (decision === 'skipped') {
      const client = await requireNativeDatabase().connect();
      try {
        await client.query('begin');
        const queue = await client.query<{ media_asset_id: string; product_intake_open: boolean }>(
          `select q.media_asset_id,
                  exists(
                    select 1 from public.product_intake_assets pia
                    join public.product_intakes pi on pi.id = pia.intake_id
                    where pia.media_asset_id = q.media_asset_id
                      and pi.status in ('draft', 'submitted', 'needs_changes')
                  ) as product_intake_open
             from public.review_queue q
            where q.id = $1 and q.status = 'pending'
            for update`,
          [id]
        );
        if (!queue.rows[0]) throw new ApiError(409, 'REVIEW_ALREADY_RESOLVED', 'Ảnh này đã được xử lý bởi một phiên khác.');
        if (queue.rows[0].product_intake_open) {
          throw new ApiError(409, 'PRODUCT_INTAKE_REVIEW_REQUIRED', 'Ảnh này thuộc hồ sơ sản phẩm mới. Hãy duyệt toàn bộ hồ sơ trong tab Hồ sơ sản phẩm.');
        }
        await client.query(
          `update public.review_queue set status = 'skipped', reviewed_by = $2, reviewed_at = now() where id = $1`,
          [id, user.id]
        );
        await client.query('commit');
        return NextResponse.json({
          data: { media_asset_id: queue.rows[0].media_asset_id, review_queue_id: id, review_status: 'skipped' },
        });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    const defaults = decision === 'approved' ? await getSharedMetadataDefaults().catch(() => null) : null;
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      // Native SKU sync has no database request identity. Set both actor values on every
      // transaction so pooled connections cannot inherit a stale human value.
      // Only approval may create a confirmed/human product link.
      await client.query(`select set_config('verity.sync_actor', $1, true)`, [decision === 'approved' ? 'human' : 'machine']);
      await client.query(`select set_config('verity.sync_actor_id', $1, true)`, [user.id]);
      const queue = await client.query<{ media_asset_id: string; metadata_draft: unknown; duplicate_asset_ids: unknown; before_value: Record<string, unknown> }>(
        `select q.media_asset_id, q.metadata_draft, q.duplicate_asset_ids,
           jsonb_build_object('sku', a.sku, 'title', a.title, 'brand', a.brand, 'category', a.category,
             'space', a.space, 'status', a.status, 'suggested_caption', a.suggested_caption,
             'author', a.author, 'copyright', a.copyright, 'credit', a.credit,
             'description', a.description, 'keywords', to_jsonb(a.keywords)) as before_value
         from public.review_queue q join public.media_assets a on a.id = q.media_asset_id
         where q.id = $1 and q.status = 'pending' and a.deleted_at is null for update`, [id]
      );
      if (!queue.rows[0]) throw new ApiError(409, 'REVIEW_ALREADY_RESOLVED', 'Ảnh này đã được xử lý bởi một phiên khác.');
      const assetId = queue.rows[0].media_asset_id;
      const openIntake = await client.query<{ exists: boolean }>(
        `select exists(
           select 1 from public.product_intake_assets pia
           join public.product_intakes pi on pi.id = pia.intake_id
           where pia.media_asset_id = $1
             and pi.status in ('draft', 'submitted', 'needs_changes')
         ) as exists`,
        [assetId]
      );
      if (openIntake.rows[0]?.exists) {
        throw new ApiError(409, 'PRODUCT_INTAKE_REVIEW_REQUIRED', 'Ảnh này thuộc hồ sơ sản phẩm mới. Hãy duyệt toàn bộ hồ sơ trong tab Hồ sơ sản phẩm.');
      }

      // Merge defaults if autoApply is enabled
      const finalAuthor = patch.author !== undefined
        ? patch.author
        : (defaults?.autoApply ? defaults.author : undefined);
      const finalCopyright = patch.copyright !== undefined
        ? patch.copyright
        : (defaults?.autoApply ? defaults.copyright : undefined);
      const finalCredit = patch.credit !== undefined
        ? patch.credit
        : (defaults?.autoApply ? defaults.credit : undefined);
      const beforeVal = queue.rows[0].before_value as Record<string, unknown> | undefined;
      const existingDesc = (typeof beforeVal?.description === 'string' ? beforeVal.description : '').trim();
      const finalDescription = patch.description !== undefined
        ? patch.description
        : (defaults?.autoApply && !existingDesc ? defaults.description : undefined);
      const finalKeywords = patch.keywords !== undefined && patch.keywords.length > 0
        ? patch.keywords
        : (defaults?.autoApply && defaults.keywords.length > 0 ? defaults.keywords : undefined);

      const effectivePatch: Record<string, unknown> = {
        ...patch,
        ...(finalAuthor !== undefined ? { author: finalAuthor } : {}),
        ...(finalCopyright !== undefined ? { copyright: finalCopyright } : {}),
        ...(finalCredit !== undefined ? { credit: finalCredit } : {}),
        ...(finalDescription !== undefined ? { description: finalDescription } : {}),
        ...(finalKeywords !== undefined ? { keywords: finalKeywords } : {}),
      };

      const targetSku = typeof effectivePatch.sku === 'string'
        ? effectivePatch.sku.trim()
        : (typeof beforeVal?.sku === 'string' ? beforeVal.sku.trim() : '');
      if (targetSku) {
        const prod = await client.query<{ brand: string }>(
          `select brand from public.verity_products where (primary_sku = $1 or code = $1) and brand is not null and trim(brand) <> '' limit 1`,
          [targetSku]
        );
        const catalogBrand = prod.rows[0]?.brand?.trim();
        if (catalogBrand) {
          const currentPatchBrand = typeof effectivePatch.brand === 'string'
            ? effectivePatch.brand.trim()
            : (typeof beforeVal?.brand === 'string' ? String(beforeVal.brand).trim() : '');
          if (!currentPatchBrand || currentPatchBrand.toLowerCase() === 'unknown' || currentPatchBrand.toUpperCase() === 'Verity') {
            effectivePatch.brand = catalogBrand;
          }
        }
      }

      // An approved asset must have a real title. Numeric/camera-generated
      // filenames such as "16" are upload artifacts, not searchable metadata.
      const currentTitle = typeof beforeVal?.title === 'string' ? beforeVal.title.trim() : '';
      const patchedTitle = (effectivePatch as Record<string, unknown>).title;
      const finalTitle = typeof patchedTitle === 'string'
        ? patchedTitle.trim()
        : currentTitle;
      if (decision === 'approved' && (!finalTitle || isGenericOrRawTitle(finalTitle))) {
        throw new ApiError(400, 'REVIEW_TITLE_REQUIRED', 'Không thể duyệt ảnh khi tiêu đề còn trống hoặc là tên file tạm.');
      }

      await client.query(
        `update public.media_assets a set
           title = case when $2::jsonb ? 'title' and nullif(trim($2::jsonb->>'title'),'') is not null then trim($2::jsonb->>'title') else a.title end,
           sku = case when $2::jsonb ? 'sku' then nullif(trim($2::jsonb->>'sku'),'') else a.sku end,
           brand = case when $2::jsonb ? 'brand' then nullif(trim($2::jsonb->>'brand'),'') else a.brand end,
           category = case when $2::jsonb ? 'category' then nullif(trim($2::jsonb->>'category'),'') else a.category end,
           space = case when $2::jsonb ? 'space' then nullif(trim($2::jsonb->>'space'),'') else a.space end,
           status = case
             when $2::jsonb ? 'status' and nullif(trim($2::jsonb->>'status'),'') is not null then trim($2::jsonb->>'status')
             when $2::jsonb ? 'status' then 'Mới'
             else a.status
           end,
           permission = case when $2::jsonb->>'permission' in ('public','internal') then $2::jsonb->>'permission' else a.permission end,
           suggested_caption = case when $2::jsonb ? 'suggested_caption' and nullif(trim($2::jsonb->>'suggested_caption'),'') is not null then trim($2::jsonb->>'suggested_caption') else a.suggested_caption end,
           author = case when $2::jsonb ? 'author' then coalesce(trim($2::jsonb->>'author'),'') else a.author end,
           copyright = case when $2::jsonb ? 'copyright' then coalesce(trim($2::jsonb->>'copyright'),'') else a.copyright end,
           credit = case when $2::jsonb ? 'credit' then coalesce(trim($2::jsonb->>'credit'),'') else a.credit end,
           description = case when $2::jsonb ? 'description' then coalesce(trim($2::jsonb->>'description'),'') else a.description end,
           keywords = case when jsonb_typeof($2::jsonb->'keywords') = 'array' then array(select jsonb_array_elements_text($2::jsonb->'keywords')) else a.keywords end,
           ai_flags = jsonb_set(
              case when $2::jsonb->>'permission' = 'internal' then jsonb_set(coalesce(a.ai_flags,'{}'::jsonb), '{is_internal}', 'true'::jsonb) when $2::jsonb->>'permission' = 'public' then jsonb_set(coalesce(a.ai_flags,'{}'::jsonb), '{is_internal}', 'false'::jsonb) else coalesce(a.ai_flags, '{}'::jsonb) end,
              '{non_catalog}',
              to_jsonb($4::boolean)
            ),
           needs_post_production = case when $5::boolean is not null then $5::boolean else a.needs_post_production end,
           review_state = case when $3 = 'approved' then 'approved' else 'rejected' end, updated_at = now()
         where a.id = $1`, [assetId, JSON.stringify(effectivePatch), decision, nonCatalog, needsPostProduction ?? null]
      );
      await client.query(
        `update public.review_queue set status = $2, user_corrections = $3::jsonb, reviewed_by = $4, reviewed_at = now() where id = $1`,
        [id, decision, JSON.stringify(corrections), user.id]
      );
      let attachedProductLinks: unknown[] = [];
      if (decision === 'approved') {
        const afterResult = await client.query<{ after_value: Record<string, unknown> }>(
          `select jsonb_build_object('sku', sku, 'title', title, 'brand', brand, 'category', category,
             'space', space, 'status', status, 'suggested_caption', suggested_caption,
             'author', author, 'copyright', copyright, 'credit', credit,
             'description', description, 'keywords', to_jsonb(keywords)) as after_value
           from public.media_assets where id = $1`, [assetId]
        );
        const before = queue.rows[0].before_value || {};
        const after = afterResult.rows[0]?.after_value || {};

        // Phase 03: Persist secondary product links, dropping any matching primary SKU
        const afterSku = typeof after.sku === 'string' ? after.sku.trim().toLowerCase() : '';
        for (const link of productLinks) {
          if (link.sku.trim().toLowerCase() === afterSku) {
            continue;
          }
          const attached = await attachMediaAssetProduct(
            {
              mediaAssetId: assetId,
              sku: link.sku,
              role: link.role,
              createdBy: user.id,
            },
            client
          );
          attachedProductLinks.push(attached);
        }

        const skuWasCorrected = corrections.sku === true && before.sku !== after.sku;
        const shouldWriteReference = Boolean(after.sku) && (skuWasCorrected || promoteReference);
        if (skuWasCorrected) {
          await client.query(
            `insert into public.review_correction_log
               (media_asset_id, review_queue_id, correction_kind, fields, before_value, after_value, reviewed_by)
             values ($1, $2, 'sku', '["sku"]'::jsonb, $3::jsonb, $4::jsonb, $5) returning id`,
            [assetId, id, JSON.stringify({ sku: before.sku ?? null }), JSON.stringify({ sku: after.sku ?? null }), user.id]
          );
        }
        if (shouldWriteReference) {
          const assetInfoResult = await client.query<{
            sku: string | null;
            category: string | null;
            ai_flags: Record<string, unknown> | null;
            ai_confidence: Record<string, unknown> | null;
          }>(
            `select sku, category, ai_flags, ai_confidence from public.media_assets where id = $1`,
            [assetId]
          );
          const assetRow = assetInfoResult.rows[0];
          const newSku = assetRow?.sku;

            // An AI asset may be reviewed and corrected, but it must never
            // enter the SKU matching/reference corpus. The database trigger
            // is the final authority; this guard preserves a successful DAM
            // decision instead of rolling the whole review transaction back.
            const isSyntheticAsset = (assetRow?.ai_flags as Record<string, unknown> | null)?.is_ai === true;
            if (newSku && !isSyntheticAsset) {
            const resolvedContext = resolveSkuContext({
              category: assetRow.category,
              non_catalog: (assetRow.ai_flags as Record<string, unknown> | null)?.non_catalog === true,
            });
            const hasPeople = Boolean((assetRow.ai_flags as Record<string, unknown> | null)?.has_people);
            const skuConfRaw = (assetRow.ai_confidence as Record<string, unknown> | null)?.sku;
            const skuConfidence = typeof skuConfRaw === 'number' ? skuConfRaw : null;

            const isPromoted = shouldPromoteToReferenceCorpus({
              context: resolvedContext,
              hasPeople,
              skuConfidence,
              explicitOptIn: promoteReference,
            });

            const linkCountResult = await client.query<{ count: string }>(
              `select count(*)::text as count from public.media_asset_products where media_asset_id = $1 and review_state != 'rejected'`,
              [assetId]
            );
            const productLinkCount = parseInt(linkCountResult.rows[0]?.count || '1', 10);

            const activeRefCheck = await client.query<{ exists: boolean }>(
              `select exists(
                 select 1 from public.sku_references
                 where sku = $1 and is_active = true and match_eligible = true and source_media_asset_id is distinct from $2
               ) as exists`,
              [newSku, assetId]
            );
            const hasActiveReferenceForSku = Boolean(activeRefCheck.rows[0]?.exists);

            const roleDecision = resolveReferenceRole({
              isPromoted,
              hasActiveReferenceForSku,
              category: assetRow.category,
              productLinkCount,
            });

            const refResult = await client.query<{ reference_id: string }>(
              `insert into public.sku_references
                  (sku, source_media_asset_id, reference_role, image_category, curation_status, is_active, match_eligible, created_by)
                values ($1, $2, $3, $4, $5, true, $6, $7)
                on conflict (sku, source_media_asset_id) where source_media_asset_id is not null
                do update set reference_role = excluded.reference_role,
                              image_category = excluded.image_category,
                              curation_status = excluded.curation_status,
                              match_eligible = excluded.match_eligible,
                              updated_at = now()
                returning reference_id`,
              [newSku, assetId, roleDecision.role, roleDecision.imageCategory, roleDecision.curationStatus, roleDecision.matchEligible, user.id]
            );

            if (isPromoted && refResult.rows[0]?.reference_id) {
              await client.query(
                `insert into public.reference_embeddings (reference_id, space_id, vector, source_sha256)
                  select $1, ae.space_id, ae.vector, ae.source_sha256
                  from public.asset_embeddings ae
                  join public.embedding_spaces es on es.space_id = ae.space_id
                  where ae.asset_id = $2 and ae.kind = 'global' and ae.vector is not null
                    and es.status in ('ACTIVE', 'SHADOW', 'DEPRECATED')
                  on conflict (reference_id, space_id)
                  do update set vector = excluded.vector, source_sha256 = excluded.source_sha256`,
                [refResult.rows[0].reference_id, assetId]
              );
            }
          }
        }
        const metadataFields = Object.keys(corrections).filter((field) => corrections[field] === true && field !== 'sku' && ['title', 'brand', 'category', 'space', 'status', 'suggested_caption', 'author', 'copyright', 'credit', 'description', 'keywords'].includes(field));
        if (metadataFields.length) {
          const log = await client.query<{ id: string }>(
            `insert into public.review_correction_log
               (media_asset_id, review_queue_id, correction_kind, fields, before_value, after_value, reviewed_by)
             values ($1, $2, 'metadata', $3::jsonb, $4::jsonb, $5::jsonb, $6) returning id`,
            [assetId, id, JSON.stringify(metadataFields), JSON.stringify(before), JSON.stringify(after), user.id]
          );
          await client.query(
            `insert into public.metadata_few_shot_examples
               (source_media_asset_id, correction_log_id, input_context, accepted_metadata, created_by)
             select a.id, $2, jsonb_build_object('origin_info', a.origin_info, 'model_draft', $3::jsonb), $4::jsonb - 'sku', $5
             from public.media_assets a
             where a.id = $1
               and coalesce(a.ai_flags -> 'is_ai', 'false'::jsonb) <> 'true'::jsonb`,
            [assetId, log.rows[0].id, JSON.stringify(queue.rows[0].metadata_draft || {}), JSON.stringify(after), user.id]
          );
        }

        if (decision === 'approved') {
          await client.query(
            `insert into public.media_usages (media_asset_id, channel, used_by, note, used_at)
             values ($1, 'review_approved', $2, 'Phê duyệt trong hàng chờ review', now())`,
            [assetId, user.email || user.id]
          );
        }

        if (replaceAssetIds.length > 0) {
          const rawDuplicateIds = Array.isArray(queue.rows[0].duplicate_asset_ids)
            ? (queue.rows[0].duplicate_asset_ids as unknown[]).filter((x): x is string => typeof x === 'string' && isUuid(x))
            : [];
          const validDuplicateSet = new Set(rawDuplicateIds);

          const remainingToCheck = replaceAssetIds.filter((idToCheck) => !validDuplicateSet.has(idToCheck));
          if (remainingToCheck.length > 0) {
            const clusterMembers = await client.query<{ media_asset_id: string }>(
              `select m2.media_asset_id
               from public.media_dedup_cluster_members m1
               join public.media_dedup_cluster_members m2 on m1.cluster_id = m2.cluster_id
               where m1.media_asset_id = $1 and m2.media_asset_id = any($2::uuid[])`,
              [assetId, remainingToCheck]
            );
            for (const row of clusterMembers.rows) {
              validDuplicateSet.add(row.media_asset_id);
            }
          }

          const invalidIds = replaceAssetIds.filter((idToCheck) => !validDuplicateSet.has(idToCheck) || idToCheck === assetId);
          if (invalidIds.length > 0) {
            throw new ApiError(400, 'INVALID_REPLACE_ASSET', `Asset ID không thuộc danh sách trùng lặp hợp lệ: ${invalidIds.join(', ')}`);
          }

          await client.query(
            `update public.media_assets
                set deleted_at = coalesce(deleted_at, now()),
                    deleted_by = coalesce(deleted_by, $2::uuid),
                    updated_at = now()
              where id = any($1::uuid[])`,
            [replaceAssetIds, user.id]
          );
          await client.query(
            `update public.media_ingest_jobs
                set status = 'cancelled',
                    completed_at = coalesce(completed_at, now()),
                    error_message = coalesce(error_message, 'Asset soft-deleted upon duplicate replacement in review queue'),
                    updated_at = now()
              where media_asset_id = any($1::uuid[])
                and status in ('queued', 'processing')`,
            [replaceAssetIds]
          );
        }
      }
      await client.query('commit');
      return NextResponse.json({
        data: {
          media_asset_id: assetId,
          review_queue_id: id,
          review_status: decision,
          product_links: attachedProductLinks,
        },
      });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
