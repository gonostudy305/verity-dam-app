import type { MediaAsset } from '@/types/media';

export type MediaSearchResultUrls = {
  cdn_url: string | null;
  file_url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Produces the URL portion of the internal media-search contract.
 *
 * A canonical publishing URL is deliberately stricter than a readable asset
 * URL. It must be a HTTPS WordPress rendition whose version is the one that
 * was actually published. Storage/proxy URLs remain compatible fallbacks but
 * are never relabelled as `cdn_url`.
 */
export function formatMediaSearchResultUrls(asset: MediaAsset): MediaSearchResultUrls {
  const canonicalVersion = Number(asset.canonical_version || 0);
  const publishedVersion = Number(asset.canonical_published_version || 0);
  const canonicalCdnUrl = typeof asset.cdn_key === 'string'
    && asset.cdn_key.startsWith('wp-content/uploads/')
    && typeof asset.cdn_url === 'string'
    && /^https:\/\/[^/]+\/wp-content\/uploads\//.test(asset.cdn_url)
    && canonicalVersion > 0
    && canonicalVersion === publishedVersion
    ? asset.cdn_url
    : null;

  const dimensions = asset.dimensions || {};
  const widthValue = Number(dimensions.width);
  const heightValue = Number(dimensions.height);
  const width = Number.isFinite(widthValue) && Number.isInteger(widthValue) && widthValue > 0 ? widthValue : null;
  const height = Number.isFinite(heightValue) && Number.isInteger(heightValue) && heightValue > 0 ? heightValue : null;

  return {
    cdn_url: canonicalCdnUrl,
    thumbnail_url: canonicalCdnUrl || asset.thumbnail_url || asset.file_url || null,
    file_url: canonicalCdnUrl || asset.file_url || null,
    width,
    height,
  };
}
