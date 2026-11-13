/**
 * Phase 2B -- Live catalog seeding + product-safe exact-SKU enforcement.
 *
 * Legacy `media_assets.sku` is a loose denormalized string. Canonical product
 * identity lives in:
 *   public.verity_products          (code, primary_sku, aliases[], brand, ...)
 *   public.media_asset_products   (media_asset_id, product_id, role, review_state)
 *
 * This module (a) seeds a DynamicCatalogResolver from verity_products, expanding
 * every code/primary_sku/alias into a lookup key sorted LONGEST-FIRST, and
 * (b) resolves the set of assets that VERIFIABLY depict a requested product,
 * using only `review_state = 'confirmed'` relationships.
 *
 * PRODUCT-SAFE GATE (product_safe_false_positive_rate = 0):
 *   For an exact-product request ("photos of the Acme D200i"), a semantically
 *   similar-but-different lock must never be returned. Only confirmed catalog
 *   relationships qualify. On ANY database error every function fails CLOSED:
 *   seeding leaves the resolver's existing (calibration) seed intact, and the
 *   safe-asset lookup returns an EMPTY set -- never a guessed match.
 *
 * All DB access goes through an injected `CatalogQueryable`, so this module is
 * unit-testable with a fake and imports no concrete pg driver.
 */

import { DynamicCatalogResolver, type CatalogSkuRecord } from './search-catalog-resolver';

export interface CatalogQueryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface CatalogSeedOptions {
  /** Only rows with is_searchable=true (default true). */
  onlySearchable?: boolean;
  /** Only lifecycle='active' rows (default true). */
  onlyActive?: boolean;
}

export interface CatalogSeedResult {
  seeded: boolean;
  productCount: number;
  keyCount: number;
  error?: string;
}

const SEED_QUERY = `
  SELECT code, primary_sku, aliases, display_name, brand, category
  FROM public.verity_products
  WHERE ($1::boolean IS FALSE OR is_searchable = true)
    AND ($2::boolean IS FALSE OR lifecycle = 'active')
`;

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

function toStrArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(toStr).filter((s): s is string => s !== undefined);
}

/**
 * Expand catalog rows into one CatalogSkuRecord per lookup key (code,
 * primary_sku, and each alias), deduplicated case-insensitively. The
 * DynamicCatalogResolver itself sorts keys longest-first on setSkus().
 */
export function expandCatalogRows(rows: Array<Record<string, unknown>>): CatalogSkuRecord[] {
  const byKey = new Map<string, CatalogSkuRecord>();
  for (const row of rows) {
    const brand = toStr(row.brand);
    const category = toStr(row.category);
    const displayName = toStr(row.display_name);
    const keys: string[] = [];
    const code = toStr(row.code);
    const primarySku = toStr(row.primary_sku);
    if (code) keys.push(code);
    if (primarySku) keys.push(primarySku);
    keys.push(...toStrArray(row.aliases));

    for (const key of keys) {
      const lower = key.toLowerCase();
      // First writer wins; keys are unique across the catalog by construction
      // (verity_products.code is UNIQUE), so collisions only happen on shared
      // aliases -- keep the earliest deterministically.
      if (!byKey.has(lower)) {
        byKey.set(lower, { sku: key, brand, category, displayName });
      }
    }
  }
  return Array.from(byKey.values());
}

/**
 * Seed (or refresh) a DynamicCatalogResolver from the live catalog.
 * Fail-closed: on query error the resolver is left untouched and seeded=false.
 */
export async function seedCatalogFromDatabase(
  resolver: DynamicCatalogResolver,
  db: CatalogQueryable,
  options: CatalogSeedOptions = {},
): Promise<CatalogSeedResult> {
  const onlySearchable = options.onlySearchable ?? true;
  const onlyActive = options.onlyActive ?? true;
  try {
    const { rows } = await db.query(SEED_QUERY, [onlySearchable, onlyActive]);
    const records = expandCatalogRows(rows);
    if (records.length === 0) {
      // Nothing to seed with -> do NOT wipe the existing calibration seed.
      return { seeded: false, productCount: rows.length, keyCount: 0, error: 'EMPTY_CATALOG' };
    }
    resolver.setSkus(records);
    return { seeded: true, productCount: rows.length, keyCount: records.length };
  } catch (error) {
    return {
      seeded: false,
      productCount: 0,
      keyCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ProductSafeLookupOptions {
  /** Restrict to these relationship roles (default: all confirmed roles). */
  roles?: ReadonlyArray<'primary' | 'secondary' | 'background' | 'packaging'>;
}

const PRODUCT_SAFE_QUERY = `
  SELECT DISTINCT map.media_asset_id
  FROM public.media_asset_products map
  JOIN public.verity_products p ON p.id = map.product_id
  WHERE map.review_state = 'confirmed'
    AND (
      lower(p.code) = lower($1)
      OR lower(p.primary_sku) = lower($1)
      OR EXISTS (SELECT 1 FROM unnest(p.aliases) a WHERE lower(a) = lower($1))
    )
    AND ($2::text[] IS NULL OR map.role = ANY($2::text[]))
`;

/**
 * Resolve the set of media_asset ids that verifiably depict the product named
 * by `token` (its code, primary_sku, or an alias), using ONLY confirmed
 * relationships. Fail-closed: on any error, returns an empty set.
 */
export async function resolveProductSafeAssetIds(
  db: CatalogQueryable,
  token: string,
  options: ProductSafeLookupOptions = {},
): Promise<Set<string>> {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (trimmed.length === 0) return new Set();
  const roles = options.roles && options.roles.length > 0 ? [...options.roles] : null;
  try {
    const { rows } = await db.query(PRODUCT_SAFE_QUERY, [trimmed, roles]);
    const ids = new Set<string>();
    for (const row of rows) {
      const id = toStr(row.media_asset_id);
      if (id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}
