/**
 * SEO-friendly image slug builder.
 * Mirrors Python `build_public_image_slug` in `backend/app/image_processing.py`.
 */
export interface AssetSlugInput {
  id?: string | null;
  brand?: string | null;
  sku?: string | null;
  title?: string | null;
  category?: string | null;
  space?: string | null;
  suggested_caption?: string | null;
  visible_text?: string[] | null;
}

/**
 * Composes a clean, human-readable, SEO-friendly asset title.
 * If the current title is already specific (not generic/raw), returns it as-is.
 * Otherwise, composes:
 *   "[Brand] [SKU] - [Space / Category / First clause of caption]"
 */
export function composeAssetTitle(asset: AssetSlugInput): string {
  const currentTitle = String(asset.title || '').trim();
  if (currentTitle && !isGenericOrRawTitle(currentTitle)) {
    return currentTitle;
  }

  const brand = String(asset.brand || '').trim();
  const sku = String(asset.sku || '').trim();
  const space = String(asset.space || '').trim();
  const category = String(asset.category || '').trim();

  const entityParts: string[] = [];
  if (brand && brand !== '—') entityParts.push(brand);
  if (sku && sku !== '—') {
    if (brand && sku.toLowerCase().startsWith(brand.toLowerCase() + ' ')) {
      entityParts.pop();
    }
    if (!entityParts.includes(sku)) {
      entityParts.push(sku);
    }
  }

  const contextParts: string[] = [];
  if (space && space !== '—') contextParts.push(space);
  else if (category && category !== '—') contextParts.push(category);

  if (entityParts.length > 0) {
    if (contextParts.length > 0) {
      return `${entityParts.join(' ')} - ${contextParts.join(' ')}`;
    }
    if (asset.suggested_caption) {
      const firstClause = asset.suggested_caption.split(/[.,;\n]/)[0]?.trim();
      if (firstClause && firstClause.length <= 60) {
        return `${entityParts.join(' ')} - ${firstClause}`;
      }
    }
    return entityParts.join(' ');
  }

  const noEntityContextParts: string[] = [];
  if (category && category !== '—') noEntityContextParts.push(category);
  if (space && space !== '—') noEntityContextParts.push(space);

  if (noEntityContextParts.length > 0) {
    return noEntityContextParts.join(' - ');
  }

  if (asset.suggested_caption) {
    const firstClause = asset.suggested_caption.split(/[.,;\n]/)[0]?.trim();
    if (firstClause) return firstClause.slice(0, 80);
  }

  return '';
}

export function buildPublicImageSlug(asset: AssetSlugInput): string {
  const brand = String(asset.brand || '').trim();
  const sku = String(asset.sku || '').trim();
  let title = String(asset.title || '').trim();

  // If title is generic or raw filename, compose clean title context if possible
  if (isGenericOrRawTitle(title)) {
    const composed = composeAssetTitle(asset);
    if (composed && !isGenericOrRawTitle(composed)) {
      title = composed;
    }
  }

  const identity: string[] = [];
  if (sku && sku !== '—' && brand && brand !== '—' && sku.toLocaleLowerCase().startsWith(`${brand.toLocaleLowerCase()} `)) {
    identity.push(sku);
  } else {
    if (brand && brand !== '—') identity.push(brand);
    if (sku && sku !== '—') identity.push(sku);
  }

  // Keep brand/SKU once. Their identity is already represented at the start
  // of the canonical URL; repeated words in a product title only make URLs
  // noisy and are deliberately removed by the mirrored Python helper.
  for (const entity of identity) {
    title = title.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  }
  title = title.replace(/\s+/g, ' ').replace(/^\s*-\s*|\s*-\s*$/g, '').trim();

  const parts = [...identity];
  if (title) parts.push(title);
  if (parts.length === 0) parts.push(String(asset.id || 'asset').slice(0, 8));

  const combined = parts.join(' ').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  // Decompose unicode characters into base and combining diacritical marks
  const normalized = combined.normalize('NFKD');
  const withoutDiacritics = normalized.replace(/[\u0300-\u036f]/g, '');
  // Replace special characters with hyphen
  const slug = withoutDiacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return slug.slice(0, 120).replace(/-+$/g, '') || 'asset';
}

/**
 * Detects whether an asset title is an unedited, raw upload filename or generic placeholder
 * (e.g. "ChatGPT Image Sep 3, 2026...", "Thiet-ke-chua-co-ten-1", "IMG_20260907...", UUID, or extension).
 */
export function isGenericOrRawTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (!trimmed || ['upload', 'untitled', 'chưa có tiêu đề', '—', '-'].includes(trimmed.toLowerCase())) return true;

  // Camera, screenshot, AI generators, and generic template naming patterns
  if (
    /^(chatgpt\s*image|thiet[-_\s]*ke[-_\s]*chua[-_\s]*co[-_\s]*ten|thiết\s*kế\s*chưa\s*có\s*tên|img[-_]|dsc[-_]|pxl[-_]|screenshot|screen\s*shot|capture|image[-_]|asset[-_]|z\d{6,})/i.test(
      trimmed
    )
  ) {
    return true;
  }

  // Raw file extensions still attached (e.g. "photo.png", "banner.webp")
  if (/\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff|svg)$/i.test(trimmed)) {
    return true;
  }

  // UUID, raw 32-hex hash, or generated dimension title
  if (/^\d+$/.test(trimmed) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) || /^[0-9a-f]{32}$/i.test(trimmed) || /^\d{2,4}x\d{2,4}(?:\s*\(\d+\))?$/i.test(trimmed)) {
    return true;
  }

  return false;
}
