import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCdnDomain, resolveMediaUrls } from './native-media';

test('resolveMediaUrls prefers only a current universal canonical CDN rendition', () => {
  const urls = resolveMediaUrls([
    {
      storage_path: 'u/2026/09/original.webp',
      thumbnail_path: 'u/2026/09/thumb.webp',
      cdn_key: 'wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp',
      cdn_url: 'https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp',
      canonical_version: 3,
      canonical_published_version: 3,
    },
  ] as any);

  const expected = 'https://assets.verity.internal/wp-content/uploads/2026/09/verity-c02-f00dbabe-768x768.webp';
  assert.equal(urls.get('u/2026/09/original.webp'), expected);
  assert.equal(urls.get('u/2026/09/thumb.webp'), expected);
});

test('resolveMediaUrls falls back to the proxy when a canonical rendition is stale or absent', () => {
  const urls = resolveMediaUrls([
    {
      storage_path: 'u/2026/09/original.webp',
      cdn_key: 'wp-content/uploads/2026/09/old.webp',
      cdn_url: 'https://assets.verity.internal/wp-content/uploads/2026/09/old.webp',
      canonical_version: 4,
      canonical_published_version: 3,
    },
  ] as any);

  assert.equal(urls.get('u/2026/09/original.webp'), '/api/r2-proxy?key=u%2F2026%2F09%2Foriginal.webp');
});

test('normalizeCdnDomain rewrites .r2.dev domains to R2_PUBLIC_BASE_URL', () => {
  const rawUrl = 'https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/sample.webp';
  const resolved = normalizeCdnDomain(rawUrl, { R2_PUBLIC_BASE_URL: 'https://cdn.example.com' });
  assert.equal(resolved, 'https://cdn.example.com/wp-content/uploads/2026/11/sample.webp');
});

test('resolveMediaUrls dynamically normalizes raw r2.dev domain when R2_PUBLIC_BASE_URL is set', () => {
  const urls = resolveMediaUrls(
    [
      {
        storage_path: 'wp-content/uploads/2026/11/sample.webp',
        thumbnail_path: 'wp-content/uploads/2026/11/sample-thumb.webp',
        file_url: 'https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/sample.webp',
        thumbnail_url: 'https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/sample-thumb.webp',
      },
    ] as any,
    { R2_PUBLIC_BASE_URL: 'https://cdn.example.com' }
  );

  assert.equal(
    urls.get('wp-content/uploads/2026/11/sample.webp'),
    'https://cdn.example.com/wp-content/uploads/2026/11/sample.webp'
  );
  assert.equal(
    urls.get('wp-content/uploads/2026/11/sample-thumb.webp'),
    'https://cdn.example.com/wp-content/uploads/2026/11/sample-thumb.webp'
  );
});

test('resolveMediaUrls falls back to proxy for soft-deleted or internal-only assets', () => {
  const urls = resolveMediaUrls(
    [
      {
        storage_path: 'wp-content/uploads/2026/11/deleted.webp',
        file_url: 'https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/deleted.webp',
        deleted_at: new Date().toISOString(),
      },
      {
        storage_path: 'wp-content/uploads/2026/11/internal.webp',
        file_url: 'https://pub-0000000000000000000000000000000.r2.dev/wp-content/uploads/2026/11/internal.webp',
        permission: 'internal',
      },
    ] as any,
    { R2_PUBLIC_BASE_URL: 'https://cdn.example.com' }
  );

  assert.equal(
    urls.get('wp-content/uploads/2026/11/deleted.webp'),
    '/api/r2-proxy?key=wp-content%2Fuploads%2F2026%2F11%2Fdeleted.webp'
  );
  assert.equal(
    urls.get('wp-content/uploads/2026/11/internal.webp'),
    '/api/r2-proxy?key=wp-content%2Fuploads%2F2026%2F11%2Finternal.webp'
  );
});
