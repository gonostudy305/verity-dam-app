import { NextRequest, NextResponse } from 'next/server';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeDatabase } from '@/lib/server/native-db';
import {
  decodeMediaCursor,
  encodeMediaCursor,
  ISO_DATE_REGEX,
  requireWordPressSyncToken,
} from '@/lib/server/wordpress';
import { buildCanonicalImageObject } from '@/lib/image-object';
import { getSharedMetadataDefaults } from '@/lib/server/metadata-defaults';

export const dynamic = 'force-dynamic';

function parseLimit(value: string | null) {
  const parsed = Number(value || 50);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}

export async function GET(request: NextRequest) {
  try {
    requireWordPressSyncToken(request.headers.get('authorization'));

    const limit = parseLimit(request.nextUrl.searchParams.get('limit'));
    const cursorParam = request.nextUrl.searchParams.get('cursor');
    const updatedAfterParam = request.nextUrl.searchParams.get('updated_after');

    // Strict validation: cursor and updated_after are mutually exclusive
    if (cursorParam && updatedAfterParam) {
      throw new ApiError(
        400,
        'INVALID_CURSOR_PARAMETERS',
        'Provide either "cursor" or "updated_after", not both.'
      );
    }

    const values: unknown[] = [limit];
    let filterClause = '';

    if (cursorParam) {
      // Lossless, deterministic composite cursor: (e.updated_at, a.id) > (t, id)
      const cursor = decodeMediaCursor(cursorParam);
      values.push(cursor.t, cursor.id);
      filterClause = 'and (e.updated_at > $2 or (e.updated_at = $2 and a.id > $3))';
    } else if (updatedAfterParam) {
      // Legacy compatibility path: updated_after has known timestamp-tie limitations
      if (!ISO_DATE_REGEX.test(updatedAfterParam) || Number.isNaN(Date.parse(updatedAfterParam))) {
        throw new ApiError(
          400,
          'INVALID_UPDATED_AFTER',
          'updated_after must be a valid ISO-8601 timestamp.'
        );
      }
      values.push(updatedAfterParam);
      filterClause = 'and e.updated_at > $2';
    }

    const [sharedDefaults, result] = await Promise.all([
      getSharedMetadataDefaults().catch(() => null),
      requireNativeDatabase().query<any>(
        `select a.id, a.sku, a.title, a.brand, a.category, a.space,
                a.author, a.credit, a.copyright,
                e.cdn_url, e.alt_text, e.caption, e.width, e.height, e.mime_type,
                to_char(e.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
                coalesce((
                  select jsonb_agg(
                    jsonb_build_object(
                      'width', r.width,
                      'height', r.height,
                      'cdn_url', r.cdn_url,
                      'format', r.format,
                      'mime_type', r.mime_type,
                      'purpose', r.purpose
                    ) order by r.width asc
                  )
                  from public.media_renditions r
                  where r.media_asset_id = a.id and r.purpose = 'web-responsive' and r.format = 'webp'
                ), '[]'::jsonb) as renditions
         from public.wordpress_media_exports e
         join public.media_assets a on a.id = e.media_asset_id
         where a.deleted_at is null and a.review_state = 'approved' and a.permission = 'public' and a.publish_status = 'published' ${filterClause}
         order by e.updated_at asc, a.id asc limit $1`,
        values
      ),
    ]);

    const assets = result.rows.map((entry: any) => {
      const renditions = Array.isArray(entry.renditions) ? entry.renditions : [];
      const variants =
        renditions.length > 0
          ? renditions.map((r: any) => ({
              width: Number(r.width),
              height: Number(r.height),
              cdn_url: String(r.cdn_url),
              format: String(r.format),
              mime_type: String(r.mime_type),
              purpose: String(r.purpose),
            }))
          : [
              {
                width: entry.width,
                height: entry.height,
                cdn_url: entry.cdn_url,
                format: entry.mime_type === 'image/webp' ? 'webp' : 'jpeg',
                mime_type: entry.mime_type,
                purpose: 'canonical',
              },
            ];

      const srcset = variants.map((v: any) => `${v.cdn_url} ${v.width}w`).join(', ');

      const imageObject = buildCanonicalImageObject({
        contentUrl: entry.cdn_url,
        width: entry.width,
        height: entry.height,
        caption: entry.caption,
        title: entry.title,
        author: entry.author,
        credit: entry.credit,
        copyright: entry.copyright,
        license: sharedDefaults?.licenseUrl || undefined,
        acquireLicensePage: sharedDefaults?.acquireLicensePage || undefined,
      });

      return {
        id: entry.id,
        sku: entry.sku || null,
        title: entry.title || '',
        brand: entry.brand || '',
        category: entry.category || '',
        space: entry.space || null,
        cdn_url: entry.cdn_url,
        alt_text: entry.alt_text,
        caption: entry.caption,
        width: entry.width,
        height: entry.height,
        mime_type: entry.mime_type,
        updated_at: entry.updated_at,
        variants,
        srcset,
        image_object: imageObject,
      };
    });

    const lastItem = assets.at(-1);
    const nextCursor = lastItem
      ? encodeMediaCursor({ t: lastItem.updated_at, id: lastItem.id })
      : null;

    return NextResponse.json({
      data: assets,
      next_cursor: nextCursor,
      next_updated_after: lastItem?.updated_at || null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
