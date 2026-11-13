/**
 * Shared SKU Context & Promotion Predicates.
 *
 * An asset belongs to one of three contexts:
 * - 'product': Single product plate (e.g. Studio catalog shot). Dominant subject, eligible for auto-promotion.
 * - 'scene': Real-world installation, full-room overview, project scene, warranty, or unclassified.
 * - 'marketing': Multi-product marketing banner or campaign collateral.
 *
 * Isomorphic: safe to import from both client React components and server routes.
 */

export type SkuContext = 'product' | 'scene' | 'marketing';

export interface SkuContextInput {
  category?: string | null;
  non_catalog?: boolean | null;
}

/**
 * Resolve the SKU context for an asset.
 *
 * Rules:
 * 1. non_catalog === true -> 'scene' (explicit human override wins over category)
 * 2. category === 'Studio' (case-insensitive) -> 'product'
 * 3. category === 'Banner' (case-insensitive) -> 'marketing'
 * 4. Everything else / empty / null / unknown -> 'scene' (fail-closed default)
 */
export function resolveSkuContext(input: SkuContextInput): SkuContext {
  if (input.non_catalog === true) {
    return 'scene';
  }
  const category = typeof input.category === 'string' ? input.category.trim().toLowerCase() : '';
  if (category === 'studio') {
    return 'product';
  }
  if (category === 'banner') {
    return 'marketing';
  }
  return 'scene';
}

/**
 * Nag suppression: suppresses low-confidence SKU warnings when the context is not 'product'.
 */
export function isSkuNagSuppressed(ctx: SkuContext): boolean {
  return ctx !== 'product';
}

/**
 * Promotion eligibility: used by Phase 04 reference corpus gate.
 * Only 'product' context is eligible for auto-promotion.
 */
export function isAutoPromotable(ctx: SkuContext): boolean {
  return ctx === 'product';
}

export interface PromotionGateInput {
  context: SkuContext;
  hasPeople?: boolean | null;
  skuConfidence?: number | null;
  explicitOptIn?: boolean | null;
}

/**
 * Gate for promoting an asset into the AI reference corpus (match_eligible=true + reference_embeddings).
 *
 * Rules:
 * 1. explicitOptIn === true -> true (reviewer explicitly overrides)
 * 2. context !== 'product' -> false (non-catalog, scene, marketing are never auto-promoted)
 * 3. hasPeople === true -> false (people shots are never auto-promoted)
 * 4. skuConfidence < 80 -> false (low-confidence SKU is never auto-promoted; null/NaN/undefined fail-closed)
 * 5. Otherwise -> true (clean Studio catalog plate)
 */
export function shouldPromoteToReferenceCorpus(input: PromotionGateInput): boolean {
  if (input.explicitOptIn === true) {
    return true;
  }
  if (input.context !== 'product') {
    return false;
  }
  if (input.hasPeople === true) {
    return false;
  }
  if (typeof input.skuConfidence !== 'number' || !Number.isFinite(input.skuConfidence)) {
    return false;
  }
  const conf = input.skuConfidence > 0 && input.skuConfidence <= 1
    ? input.skuConfidence * 100
    : input.skuConfidence;
  return conf >= 80;
}

