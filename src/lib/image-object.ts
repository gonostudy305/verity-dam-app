/**
 * Canonical Schema.org ImageObject and HTML/JSON-LD Escaping Helpers.
 * Shared between Server API (/api/wordpress/media) and Client Studio (DetailDrawer).
 */

export interface CanonicalImageObjectParams {
  contentUrl: string;
  width: number;
  height: number;
  caption?: string | null;
  name?: string | null;
  title?: string | null;
  author?: string | null;
  credit?: string | null;
  copyright?: string | null;
  license?: string;
  acquireLicensePage?: string;
}

export interface SchemaOrgImageObject {
  '@context': 'https://schema.org';
  '@type': 'ImageObject';
  contentUrl: string;
  width: number;
  height: number;
  caption?: string;
  name?: string;
  creator: {
    '@type': 'Organization' | 'Person';
    name: string;
  };
  creditText: string;
  copyrightNotice: string;
  license?: string;
  acquireLicensePage?: string;
}

/**
 * Escapes characters for safe inclusion in HTML attribute values.
 */
export function escapeHtmlAttribute(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Serializes an object to JSON-LD safely for embedding inside <script> tags.
 * Replaces '<' with unicode escape '\u003c' to prevent script breakout / XSS.
 */
export function safeJsonLd(obj: unknown): string {
  return JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
}

/**
 * Builds the canonical Schema.org ImageObject metadata structure according to
 * Google Search Central & IPTC recommendations.
 *
 * Creator Attribution Rule:
 * - Default author 'VerityDAM Platform' (or empty/whitespace) resolves to '@type': 'Organization'.
 * - Custom non-Verity author string resolves to '@type': 'Person' (heuristic until explicit
 *   author_type is modeled in the database schema).
 *
 * License Policy:
 * - To comply with Google guidelines, license and acquireLicensePage are ONLY emitted
 *   when real, accessible policy URLs are explicitly provided (KISS; avoids 404 targets).
 */
export function buildCanonicalImageObject(params: CanonicalImageObjectParams): SchemaOrgImageObject {
  const trimmedAuthor = params.author?.trim();
  const isDefaultOrganization =
    !trimmedAuthor ||
    trimmedAuthor.toLowerCase() === 'verity' ||
    trimmedAuthor.toLowerCase() === 'verity home appliance' ||
    trimmedAuthor.toLowerCase() === 'veritydam' ||
    trimmedAuthor.toLowerCase() === 'veritydam platform';

  const creator = isDefaultOrganization
    ? {
        '@type': 'Organization' as const,
        name: trimmedAuthor || 'VerityDAM Platform',
      }
    : {
        // Heuristic: custom non-Verity author treated as Person until author_type is explicitly added to the data model.
        '@type': 'Person' as const,
        name: trimmedAuthor,
      };

  const captionText = params.caption?.trim() || params.title?.trim() || undefined;
  const nameText = params.name?.trim() || params.title?.trim() || undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    contentUrl: params.contentUrl,
    width: params.width,
    height: params.height,
    ...(captionText ? { caption: captionText } : {}),
    ...(nameText ? { name: nameText } : {}),
    creator,
    creditText: params.credit?.trim() || 'VerityDAM Platform',
    copyrightNotice: params.copyright?.trim() || 'Copyright 2026 VerityDAM Platform. All rights reserved.',
    ...(params.license?.trim() ? { license: params.license.trim() } : {}),
    ...(params.acquireLicensePage?.trim() ? { acquireLicensePage: params.acquireLicensePage.trim() } : {}),
  };
}
