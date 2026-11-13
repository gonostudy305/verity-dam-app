import { NextRequest, NextResponse } from 'next/server';

import {
  isUuid,
  parseReviewDecision,
  restrictReviewPatchToFields,
  sanitizeReviewCorrections,
  sanitizeReviewPatchFields,
  sanitizeReviewPatch,
  sanitizeReviewNonCatalog,
  sanitizeReviewPromoteReference,
  sanitizeReviewNeedsPostProduction,
  sanitizeReviewProductLinks,
  ValidationError,
} from '@/lib/media-api';
import { resolveSkuContext, shouldPromoteToReferenceCorpus } from '@/lib/sku-context';
import { resolveReferenceRole } from '@/lib/reference-role';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { getSharedMetadataDefaults } from '@/lib/server/metadata-defaults';
import { attachMediaAssetProduct } from '@/lib/server/native-media';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => {
      throw new ValidationError('Nội dung yêu cầu phải là JSON hợp lệ.');
    });

    const rawQueueIds = Array.isArray(body?.queue_ids) ? body.queue_ids : [];
    const queueIds = rawQueueIds.filter((item: unknown): item is string => typeof item === 'string' && isUuid(item));

    if (queueIds.length === 0) {
      throw new ApiError(400, 'INVALID_QUEUE_IDS', 'Danh sách ID hàng chờ không hợp lệ hoặc rỗng.');
    }
    if (queueIds.length > 100) {
      throw new ApiError(400, 'BATCH_TOO_LARGE', 'Mỗi lần duyệt hàng loạt tối đa 100 ảnh.');
    }

    const decision = parseReviewDecision(body?.decision);
    const patchFields = sanitizeReviewPatchFields(body?.patch_fields);
    const patch = restrictReviewPatchToFields(sanitizeReviewPatch(body?.patch), patchFields);
    // In batch review, title is never overwritten so each individual photo retains its own distinct title/caption
    delete patch.title;

    const corrections = restrictReviewPatchToFields(sanitizeReviewCorrections(body?.corrections), patchFields);
    const nonCatalog = sanitizeReviewNonCatalog(body?.non_catalog);
    const promoteReference = sanitizeReviewPromoteReference(body?.promote_reference);
    const needsPostProduction = sanitizeReviewNeedsPostProduction(body?.needs_post_production ?? (body?.patch as Record<string, unknown> | undefined)?.needs_post_production);
    const productLinks = sanitizeReviewProductLinks(body?.product_links);

    const rawRefQueueId = typeof body?.reference_queue_id === 'string' && isUuid(body.reference_queue_id)
      ? body.reference_queue_id
      : queueIds[0];
    const referenceQueueId = queueIds.includes(rawRefQueueId) ? rawRefQueueId : queueIds[0];

    const { user } = await requireNativeReviewer();

    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');

      // Check lock on all pending review_queue rows
      const queueRows = await client.query<{
        id: string;
        media_asset_id: string;
        metadata_draft: unknown;
        duplicate_asset_ids: unknown;
        before_value: Record<string, unknown>;
      }>(
        `select q.id, q.media_asset_id, q.metadata_draft, q.duplicate_asset_ids,
           jsonb_build_object('sku', a.sku, 'title', a.title, 'brand', a.brand, 'category', a.category,
             'space', a.space, 'status', a.status, 'suggested_caption', a.suggested_caption,
             'author', a.author, 'copyright', a.copyright, 'credit', a.credit,
             'description', a.description, 'keywords', to_jsonb(a.keywords)) as before_value
         from public.review_queue q
         join public.media_assets a on a.id = q.media_asset_id
         where q.id = any($1::uuid[]) and q.status = 'pending' and a.deleted_at is null
         for update`,
        [queueIds]
      );

      if (queueRows.rows.length === 0) {
        throw new ApiError(409, 'REVIEW_ALREADY_RESOLVED', 'Các ảnh này đã được xử lý bởi một phiên khác.');
      }

      const foundQueueIds = queueRows.rows.map((r) => r.id);
      const assetIds = queueRows.rows.map((r) => r.media_asset_id);

      // Verify no open product intakes for these assets
      const openIntake = await client.query<{ exists: boolean }>(
        `select exists(
           select 1 from public.product_intake_assets pia
           join public.product_intakes pi on pi.id = pia.intake_id
           where pia.media_asset_id = any($1::uuid[])
             and pi.status in ('draft', 'submitted', 'needs_changes')
         ) as exists`,
        [assetIds]
      );

      if (openIntake.rows[0]?.exists) {
        throw new ApiError(409, 'PRODUCT_INTAKE_REVIEW_REQUIRED', 'Một số ảnh trong lô thuộc hồ sơ sản phẩm mới. Hãy duyệt toàn bộ hồ sơ trong tab Hồ sơ sản phẩm.');
      }

      if (decision === 'skipped') {
        await client.query(
          `update public.review_queue
           set status = 'skipped', reviewed_by = $2, reviewed_at = now()
           where id = any($1::uuid[])`,
          [foundQueueIds, user.id]
        );
        await client.query('commit');
        return NextResponse.json({
          data: {
            processed_count: foundQueueIds.length,
            review_status: 'skipped',
            queue_ids: foundQueueIds,
          },
        });
      }

      await client.query(`select set_config('verity.sync_actor', $1, true)`, [decision === 'approved' ? 'human' : 'machine']);
      await client.query(`select set_config('verity.sync_actor_id', $1, true)`, [user.id]);

      const defaults = decision === 'approved' ? await getSharedMetadataDefaults().catch(() => null) : null;

      // With the optional allow-list, an omitted field means exactly "do not
      // touch it". Without it this remains the legacy default-injection path.
      const allows = (field: string) => patchFields === null || patchFields.has(field as never);
      const finalAuthor = patch.author !== undefined
        ? patch.author
        : (allows('author') && defaults?.autoApply ? defaults.author : undefined);
      const finalCopyright = patch.copyright !== undefined
        ? patch.copyright
        : (allows('copyright') && defaults?.autoApply ? defaults.copyright : undefined);
      const finalCredit = patch.credit !== undefined
        ? patch.credit
        : (allows('credit') && defaults?.autoApply ? defaults.credit : undefined);
      const finalDescription = patch.description !== undefined
        ? patch.description
        : (allows('description') && defaults?.autoApply ? defaults.description : undefined);
      const finalKeywords = patch.keywords !== undefined && patch.keywords.length > 0
        ? patch.keywords
        : (allows('keywords') && defaults?.autoApply && defaults.keywords.length > 0 ? defaults.keywords : undefined);

      const effectivePatch: Record<string, any> = {
        ...patch,
        ...(finalAuthor !== undefined ? { author: finalAuthor } : {}),
        ...(finalCopyright !== undefined ? { copyright: finalCopyright } : {}),
        ...(finalCredit !== undefined ? { credit: finalCredit } : {}),
        ...(finalDescription !== undefined ? { description: finalDescription } : {}),
        ...(finalKeywords !== undefined ? { keywords: finalKeywords } : {}),
      };

      // Update all assets in the batch
      await client.query(
        `update public.media_assets a set
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
          where a.id = any($1::uuid[])`,
         [assetIds, JSON.stringify(effectivePatch), decision, nonCatalog, needsPostProduction ?? null]
       );

      // Update review queue records
      await client.query(
        `update public.review_queue
         set status = $2, user_corrections = $3::jsonb, reviewed_by = $4, reviewed_at = now()
         where id = any($1::uuid[])`,
        [foundQueueIds, decision, JSON.stringify(corrections), user.id]
      );

      if (decision === 'approved') {
        // Record media_usages for all approved assets
        await client.query(
          `insert into public.media_usages (media_asset_id, channel, used_by, note, used_at)
           select id, 'review_approved', $2, 'Phê duyệt hàng loạt trong hàng chờ review', now()
           from unnest($1::uuid[]) as id`,
          [assetIds, user.email || user.id]
        );

        // Attach secondary product links to all assets if provided
        const targetSku = typeof patch.sku === 'string' ? patch.sku.trim().toLowerCase() : '';
        for (const link of productLinks) {
          if (link.sku.trim().toLowerCase() === targetSku) {
            continue;
          }
          for (const aId of assetIds) {
            try {
              await attachMediaAssetProduct(
                {
                  mediaAssetId: aId,
                  sku: link.sku,
                  role: link.role,
                  createdBy: user.id,
                },
                client
              );
            } catch (attachError) {
              if (attachError instanceof ApiError && attachError.status === 409) {
                continue;
              }
              throw attachError;
            }
          }
        }

        // Apply SKU Reference ONLY to the chosen single reference asset
        const refQueueRow = queueRows.rows.find((r) => r.id === referenceQueueId) || queueRows.rows[0];
        const refAssetId = refQueueRow?.media_asset_id;

        if (refAssetId) {
          const skuWasCorrected = corrections.sku === true;
          const patchSku = typeof patch.sku === 'string' ? patch.sku.trim() : '';
          const shouldWriteReference = Boolean(patchSku) && (skuWasCorrected || promoteReference);

          if (skuWasCorrected) {
            await client.query(
              `insert into public.review_correction_log
                 (media_asset_id, review_queue_id, correction_kind, fields, before_value, after_value, reviewed_by)
               values ($1, $2, 'sku', '["sku"]'::jsonb, $3::jsonb, $4::jsonb, $5)`,
              [
                refAssetId,
                refQueueRow.id,
                JSON.stringify({ sku: refQueueRow.before_value?.sku ?? null }),
                JSON.stringify({ sku: patchSku }),
                user.id,
              ]
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
              [refAssetId]
            );
            const assetRow = assetInfoResult.rows[0];
            const newSku = assetRow?.sku;

            // Keep DAM approval/correction independent from reference corpus
            // promotion. Synthetic assets are never matching ground truth.
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
                [refAssetId]
              );
              const productLinkCount = parseInt(linkCountResult.rows[0]?.count || '1', 10);

              const activeRefCheck = await client.query<{ exists: boolean }>(
                `select exists(
                   select 1 from public.sku_references
                   where sku = $1 and is_active = true and match_eligible = true and source_media_asset_id is distinct from $2
                 ) as exists`,
                [newSku, refAssetId]
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
                [
                  newSku,
                  refAssetId,
                  roleDecision.role,
                  roleDecision.imageCategory,
                  roleDecision.curationStatus,
                  roleDecision.matchEligible,
                  user.id,
                ]
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
                  [refResult.rows[0].reference_id, refAssetId]
                );
              }
            }
          }
        }
      }

      await client.query('commit');

      return NextResponse.json({
        data: {
          processed_count: foundQueueIds.length,
          review_status: decision,
          queue_ids: foundQueueIds,
          reference_queue_id: referenceQueueId,
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
