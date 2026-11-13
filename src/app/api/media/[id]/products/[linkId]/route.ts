import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { mapMediaAssetProductLink } from '@/lib/server/media-mapper';
import { requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string; linkId: string }>;
}

type ProductLinkAction = 'confirm' | 'reject' | 'set_primary';
const ACTIONS = new Set<ProductLinkAction>(['confirm', 'reject', 'set_primary']);

/** Batch 3: reviewer actions on one media_asset_products relation --
 * confirm/reject the link, or set_primary (promote it to the asset's single
 * primary product). Deliberately scoped to this relation only: it never
 * writes back to media_assets.sku/brand, so it cannot interact with the
 * DB-side sync triggers in 0011_media_asset_product_sku_sync.sql. */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const { id, linkId } = await params;
    if (!isUuid(id) || !isUuid(linkId)) {
      throw new ApiError(400, 'INVALID_ID', 'ID không hợp lệ.');
    }
    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (!body.action || !ACTIONS.has(body.action as ProductLinkAction)) {
      throw new ApiError(400, 'INVALID_ACTION', 'Hành động không hợp lệ. Chỉ chấp nhận confirm, reject, set_primary.');
    }
    const action = body.action as ProductLinkAction;

    await requireNativeReviewer();

    const pool = requireNativeDatabase();
    const client = await pool.connect();
    try {
      await client.query('begin');

      const existing = await client.query<{ id: string }>(
        `select id from public.media_asset_products where id = $1 and media_asset_id = $2 for update`,
        [linkId, id]
      );
      if (!existing.rows[0]) throw notFound();

      if (action === 'set_primary') {
        // uq_native_media_asset_primary_product only allows one
        // (role='primary', review_state<>'rejected') row per asset -- demote
        // any other such row first, in the same transaction, to avoid a
        // unique-constraint violation on the promotion below.
        await client.query(
          `update public.media_asset_products
              set role = 'secondary'
            where media_asset_id = $1 and role = 'primary' and review_state <> 'rejected' and id <> $2`,
              [id, linkId]
        );
      }

      const returning = `returning id, product_id, role, confidence, source, review_state, created_at,
            (select code from public.verity_products p where p.id = product_id) as code,
            (select display_name from public.verity_products p where p.id = product_id) as display_name,
            (select brand from public.verity_products p where p.id = product_id) as brand,
            (select model_name from public.verity_products p where p.id = product_id) as model_name,
            (select category from public.verity_products p where p.id = product_id) as category`;

      const updated = action === 'confirm'
        ? await client.query<Record<string, unknown>>(
            `update public.media_asset_products set review_state = 'confirmed' where id = $1 ${returning}`,
            [linkId]
          )
        : action === 'reject'
          ? await client.query<Record<string, unknown>>(
              `update public.media_asset_products set review_state = 'rejected' where id = $1 ${returning}`,
              [linkId]
            )
          : await client.query<Record<string, unknown>>(
              `update public.media_asset_products set role = 'primary', review_state = 'confirmed' where id = $1 ${returning}`,
            [linkId]
            );

      await client.query('commit');
      return NextResponse.json({ success: true, data: mapMediaAssetProductLink(updated.rows[0]) });
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
