// R0.1 feature flag (Part 14). Matches the repo's existing convention of
// `process.env.VERITY_XXX === 'true'` string comparison (see src/lib/auth.ts,
// src/lib/server/native-db.ts, src/app/api/settings/probe-models/route.ts).
//
// Default is FALSE. When false, callers must fall back to the existing
// BASELINE_L0 production search path unchanged -- see
// search-intelligence-gateway.ts for the fallback wiring and
// search-intelligence-gateway.test.ts for the behavioral-equivalence proof.

export type FlagEnvSource = Readonly<Record<string, string | undefined>>;

export function isSearchIntelligenceV1Enabled(
  env: FlagEnvSource = process.env,
): boolean {
  return env.VERITY_SEARCH_INTELLIGENCE_V1_ENABLED === 'true';
}

export function isSearchShadowV1Enabled(
  env: FlagEnvSource = process.env,
): boolean {
  return env.VERITY_SEARCH_SHADOW_V1_ENABLED === 'true';
}

// Phase 2B: DB-backed dynamic catalog resolver + product-safe exact SKU.
// Default FALSE. When false, exact-SKU behavior is the byte-identical
// catalog-agnostic Tier-0 path (search-intelligence-exact.ts); the live
// verity_products / media_asset_products join is never consulted.
export function isSearchCatalogV1Enabled(
  env: FlagEnvSource = process.env,
): boolean {
  return env.VERITY_SEARCH_CATALOG_V1_ENABLED === 'true';
}

// Phase 2C: MMR visual diversification of the displayed prefix.
// Default FALSE. Activation is gated on Gold Benchmark #42 (NDCG@10 must not
// regress) per the Zero-Blind-Tuning invariant -- do NOT enable in production
// until real relevance grades exist. When false, result order is unchanged.
export function isSearchMmrV1Enabled(
  env: FlagEnvSource = process.env,
): boolean {
  return env.VERITY_SEARCH_MMR_V1_ENABLED === 'true';
}

