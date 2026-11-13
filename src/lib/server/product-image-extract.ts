/**
 * Trích danh sách URL ảnh ứng viên từ HTML của một trang sản phẩm.
 *
 * Pure function, không I/O — route `/api/uploads/from-url/extract` lo phần
 * fetch, ở đây chỉ parse. Ba tầng theo độ tin cậy giảm dần:
 *   1. JSON-LD `Product.image` — chuẩn nhất, thường có cả gallery.
 *   2. OpenGraph / Twitter — hay bị crop cho social, nhưng gần như site nào cũng có.
 *   3. `<img>` + `srcset` — bắt được phần còn lại, kèm lọc rác theo tên file.
 *
 * Dùng regex + JSON.parse thay vì cheerio/jsdom để không thêm dependency runtime.
 */

export type ImageCandidateSource = 'jsonld' | 'meta' | 'img';

export interface ImageCandidate {
  url: string;
  source: ImageCandidateSource;
}

export const MAX_IMAGE_CANDIDATES = 40;

/** Tên file gợi ý ảnh giao diện, không phải ảnh sản phẩm. Chỉ áp dụng cho
 * tầng `<img>`; JSON-LD và og:image là ảnh site tự khai nên được tin. */
const JUNK_NAME =
  /(?:^|[/_-])(?:logo|icon|favicon|sprite|avatar|placeholder|spinner|loading|blank|pixel|1x1|banner|badge)(?:[/_.-]|$)/i;

function decodeEntities(value: string): string {
  return value
    .replace(/&(?:amp|#0*38|#[xX]0*26);/g, '&')
    .replace(/&(?:quot|#0*34);/g, '"')
    .replace(/&(?:apos|#0*39);/g, "'")
    .replace(/&(?:lt|#0*60);/g, '<')
    .replace(/&(?:gt|#0*62);/g, '>');
}

/** Chuẩn hoá về absolute http(s) URL, bỏ fragment. Trả null nếu không dùng được. */
function absolute(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== 'string') return null;
  const value = decodeEntities(raw.trim());
  if (!value || value.startsWith('data:')) return null;
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (/\.svg$/i.test(url.pathname)) return null;
  url.hash = '';
  return url.toString();
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

/** Lấy ứng viên lớn nhất trong srcset (`w` ưu tiên theo pixel, `x` theo mật độ). */
export function largestFromSrcset(srcset: string): string | null {
  let best: { url: string; weight: number } | null = null;
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const candidate = bits[0];
    if (!candidate) continue;
    const descriptor = /^(\d+(?:\.\d+)?)([wx])$/.exec(bits[1] || '');
    const weight = descriptor
      ? descriptor[2] === 'w'
        ? Number(descriptor[1])
        : Number(descriptor[1]) * 1000
      : 1;
    if (!best || weight > best.weight) best = { url: candidate, weight };
  }
  return best?.url ?? null;
}

function isProductType(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => typeof entry === 'string' && /product/i.test(entry));
}

function collectImageValue(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectImageValue(entry, into);
    return;
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    collectImageValue(node.url ?? node.contentUrl, into);
  }
}

/** Duyệt cả cây JSON-LD (kể cả `@graph`) để không phụ thuộc cách site lồng node. */
function walkJsonLd(node: unknown, into: string[], depth = 0): void {
  if (depth > 8 || !node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const entry of node) walkJsonLd(entry, into, depth + 1);
    return;
  }
  const record = node as Record<string, unknown>;
  if (isProductType(record['@type'])) collectImageValue(record.image, into);
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') walkJsonLd(value, into, depth + 1);
  }
}

export function extractImageCandidates(
  html: string,
  baseUrl: string,
  limit: number = MAX_IMAGE_CANDIDATES
): ImageCandidate[] {
  const source = typeof html === 'string' ? html : '';
  const seen = new Set<string>();
  const out: ImageCandidate[] = [];

  const push = (raw: unknown, origin: ImageCandidateSource) => {
    if (out.length >= limit) return;
    const url = absolute(raw, baseUrl);
    if (!url || seen.has(url)) return;
    if (origin === 'img' && JUNK_NAME.test(new URL(url).pathname)) return;
    seen.add(url);
    out.push({ url, source: origin });
  };

  // 1. JSON-LD Product.image
  const jsonLd = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let match = jsonLd.exec(source); match; match = jsonLd.exec(source)) {
    const images: string[] = [];
    try {
      walkJsonLd(JSON.parse(match[1].trim()), images);
    } catch {
      continue; // JSON-LD hỏng là chuyện thường; các tầng sau vẫn chạy.
    }
    for (const image of images) push(image, 'jsonld');
  }

  // 2. OpenGraph / Twitter
  const metaByKey = new Map<string, string>();
  const metaTags = /<meta\b[^>]*>/gi;
  for (let match = metaTags.exec(source); match; match = metaTags.exec(source)) {
    const tag = match[0];
    const key = (attr(tag, 'property') || attr(tag, 'name') || '').trim().toLowerCase();
    const content = attr(tag, 'content');
    if (!key || !content || metaByKey.has(key)) continue;
    metaByKey.set(key, content);
  }
  for (const key of ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    const content = metaByKey.get(key);
    if (content) push(content, 'meta');
  }

  // 3. <img> + srcset (kể cả các biến thể lazy-load phổ biến)
  const imgTags = /<img\b[^>]*>/gi;
  for (let match = imgTags.exec(source); match; match = imgTags.exec(source)) {
    const tag = match[0];
    const srcset = attr(tag, 'srcset') || attr(tag, 'data-srcset');
    const best = srcset ? largestFromSrcset(decodeEntities(srcset)) : null;
    const direct =
      attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src');
    push(best || direct, 'img');
  }

  return out;
}
