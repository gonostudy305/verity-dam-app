// Phase 1B feature flag (#44). Matches the repo's existing convention of
// `process.env.VERITY_XXX === 'true'` string comparison (see
// search-intelligence-flag.ts, src/lib/auth.ts, src/lib/server/native-db.ts).
//
// Gates the wiring of deterministic query-derived HARD constraints
// (buildSearchPlan -> SearchConstraints) into the BASELINE_L0 media search
// path. Default is FALSE: when false, listNativeLibraryMedia never calls
// buildSearchPlan and emits SQL byte-for-byte identical to the pre-wiring
// baseline (see native-media-constraints.test.ts for the parity proof).
//
// Governance: this flag stays OFF in every deployed environment until Gate
// Q0-C (#41) passes on staging. The branch is Draft-only and unmerged.

export type FlagEnvSource = Readonly<Record<string, string | undefined>>;

export function isSearchConstraintsV1Enabled(
  env: FlagEnvSource = process.env,
): boolean {
  return env.VERITY_SEARCH_CONSTRAINTS_V1_ENABLED === 'true';
}
