import { NextRequest, NextResponse } from 'next/server';

import { isUuid } from '@/lib/media-api';
import { ApiError, errorResponse, notFound } from '@/lib/server/http';
import { getNativeMediaAsset, saveNativeMediaCropConfig } from '@/lib/server/native-media';
import { requireNativeAdmin, requireNativeMember, requireNativeReviewer } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { softDeleteMediaAssets } from '@/lib/server/media-soft-delete';
import { isGenericOrRawTitle } from '@/lib/image-slug';


export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    }
    const includeDeleted = ['1', 'true'].includes((_request.nextUrl.searchParams.get('include_deleted') || '').toLowerCase());
    const context = includeDeleted ? await requireNativeAdmin() : await requireNativeMember();
    return NextResponse.json({ data: await getNativeMediaAsset(id, context.role === 'reviewer' || context.role === 'admin', includeDeleted, context.role !== 'viewer') });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    }

    const { user } = await requireNativeAdmin();
    const client = await requireNativeDatabase().connect();
    try {
      await client.query('begin');
      const result = await softDeleteMediaAssets(client, [id], user.id, 'Asset soft-deleted by an administrator');
      await client.query('commit');

      return NextResponse.json({
        success: true,
        data: {
          id,
          deleted_at: result.deletedAtById[id],
          deleted_by: result.deletedByById[id] || user.id,
          cancelled_jobs: result.cancelledJobs,
          cleaned_duplicate_queues: result.cleanedDuplicateQueues,
          already_deleted: result.alreadyDeleted > 0,
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

export async function POST(request: NextRequest, context: RouteContext) {
  return handleCropOrUpdate(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return handleCropOrUpdate(request, context);
}

async function handleCropOrUpdate(request: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      throw new ApiError(400, 'INVALID_ID', 'ID media không hợp lệ.');
    }

    const body = (await request.json().catch(() => ({}))) as {
      presetId?: string;
      crop?: any;
      title?: string;
      sku?: string | null;
      needs_post_production?: boolean;
      suggested_caption?: string | null;
      description?: string;
      keywords?: string[];
      permission?: 'public' | 'internal';
      category?: string | null;
      space?: string | null;
      status?: string;
    };

    const hasMetadataUpdate =
      body.sku !== undefined ||
      body.needs_post_production !== undefined ||
      body.title !== undefined ||
      body.suggested_caption !== undefined ||
      body.description !== undefined ||
      body.keywords !== undefined ||
      body.permission !== undefined ||
      body.category !== undefined ||
      body.space !== undefined ||
      body.status !== undefined;

    if (hasMetadataUpdate) {
      const { user } = await requireNativeReviewer();
      const setClauses: string[] = [];
      const values: unknown[] = [id];

      if (body.sku !== undefined) {
        const rawSku = typeof body.sku === 'string' ? body.sku.trim() : '';
        const cleanSku = rawSku ? rawSku.slice(0, 100) : null;
        values.push(cleanSku);
        setClauses.push(`sku = $${values.length}`);
      }

      if (body.needs_post_production !== undefined) {
        const flag = Boolean(body.needs_post_production);
        values.push(flag);
        setClauses.push(`needs_post_production = $${values.length}`);
      }

      if (body.title !== undefined) {
        const cleanTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
        if (!cleanTitle || isGenericOrRawTitle(cleanTitle)) {
          throw new ApiError(400, 'INVALID_TITLE', 'Tiêu đề phải là tên mô tả, không phải số hoặc tên file tạm.');
        }
        values.push(cleanTitle);
        setClauses.push(`title = $${values.length}`);
      }

      if (body.suggested_caption !== undefined) {
        const rawCaption = typeof body.suggested_caption === 'string' ? body.suggested_caption.trim().slice(0, 2000) : null;
        values.push(rawCaption);
        setClauses.push(`suggested_caption = $${values.length}`);
      }

      if (body.description !== undefined) {
        const rawDesc = typeof body.description === 'string' ? body.description.trim().slice(0, 5000) : '';
        values.push(rawDesc);
        setClauses.push(`description = $${values.length}`);
      }

      if (body.keywords !== undefined) {
        const rawKeywords = Array.isArray(body.keywords) ? body.keywords : [];
        const cleanKeywords = Array.from(
          new Set(
            rawKeywords
              .map((k) => (typeof k === 'string' ? k.replace(/^#+/, '').trim() : ''))
              .filter((k) => k.length > 0 && k.length <= 50)
          )
        ).slice(0, 50);
        values.push(cleanKeywords);
        setClauses.push(`keywords = $${values.length}::text[]`);
      }

      if (body.permission !== undefined) {
        if (!['public', 'internal'].includes(body.permission)) {
          throw new ApiError(400, 'INVALID_PERMISSION', 'Quyền truy cập phải là public hoặc internal.');
        }
        values.push(body.permission);
        setClauses.push(`permission = $${values.length}`);
      }

      if (body.category !== undefined) {
        const rawCat = typeof body.category === 'string' ? body.category.trim().slice(0, 100) : null;
        values.push(rawCat);
        setClauses.push(`category = $${values.length}`);
      }

      if (body.space !== undefined) {
        const rawSpace = typeof body.space === 'string' ? body.space.trim().slice(0, 100) : null;
        values.push(rawSpace);
        setClauses.push(`space = $${values.length}`);
      }

      if (body.status !== undefined) {
        const rawStatus = typeof body.status === 'string' ? body.status.trim().slice(0, 100) : 'Mới';
        values.push(rawStatus);
        setClauses.push(`status = $${values.length}`);
      }

      if (setClauses.length > 0) {
        const pool = requireNativeDatabase();
        const client = await pool.connect();
        try {
          await client.query('begin');
          await client.query(`select set_config('verity.sync_actor', 'human', true)`);
          if (user?.id) {
            await client.query(`select set_config('verity.sync_actor_id', $1, true)`, [user.id]);
          }
          const res = await client.query<{ id: string }>(
            `update public.media_assets
                set ${setClauses.join(', ')},
                    updated_at = now()
              where id = $1
                and deleted_at is null
            returning id`,
            values
          );
          if (!res.rows[0]) throw notFound();
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw err;
        } finally {
          client.release();
        }
        const updated = await getNativeMediaAsset(id, true, false, true);
        return NextResponse.json({
          success: true,
          data: updated,
        });
      }
    }

    const presetId = typeof body.presetId === 'string' ? body.presetId : '';
    const crop = body.crop;

    if (!presetId || !crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.y) || !Number.isFinite(crop.width) || !Number.isFinite(crop.height) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
      throw new ApiError(400, 'INVALID_CROP_PAYLOAD', 'Dữ liệu cấu hình cắt ảnh không hợp lệ.');
    }

    const { user } = await requireNativeReviewer();
    const updatedCropConfigs = await saveNativeMediaCropConfig(id, presetId, crop, user.email || user.id);

    return NextResponse.json({
      success: true,
      data: updatedCropConfigs,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
