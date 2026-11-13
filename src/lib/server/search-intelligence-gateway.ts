// R0.1 gateway (Parts 14/15): a dependency-injected wrapper around the
// existing baseline search path and an optional, not-yet-production
// intelligence path.
//
// Rules (both enforced by search-intelligence-gateway.test.ts):
//  1. If the flag is false, or no intelligence function is supplied, the
//     baseline function's result is returned as-is -- no wrapping, no
//     shape change, no behavior change. This is the "behavioral
//     equivalence" requirement from Part 14.
//  2. If the flag is true and an intelligence function is supplied, it is
//     tried first; ANY error it throws (sync throw or rejected promise)
//     falls back to the baseline result immediately. No search outage,
//     no DB mutation, no persistent config change (Part 15).
//
// This file intentionally does not import or reference any concrete
// search_intelligence Python module -- it is a pure TS seam a future,
// separately-authorized integration would fill in.

import { isSearchIntelligenceV1Enabled } from './search-intelligence-flag';

export type SearchGatewayFn<T> = () => T | Promise<T>;

export interface SearchIntelligenceGatewayOptions<T> {
  baseline: SearchGatewayFn<T>;
  intelligence?: SearchGatewayFn<T>;
  isEnabled?: () => boolean;
  shadow?: (baselineResult: T) => void | Promise<unknown>;
}

export async function runSearchIntelligenceGateway<T>(
  options: SearchIntelligenceGatewayOptions<T>,
): Promise<T> {
  const { baseline, intelligence, isEnabled = isSearchIntelligenceV1Enabled, shadow } = options;

  if (!isEnabled() || !intelligence) {
    const result = await baseline();
    if (shadow) {
      try {
        const shadowPromise = shadow(result);
        if (shadowPromise && typeof (shadowPromise as Promise<unknown>).catch === 'function') {
          (shadowPromise as Promise<unknown>).catch(() => {});
        }
      } catch {
        // Shadow failure must never affect baseline result
      }
    }
    return result;
  }

  try {
    return await intelligence();
  } catch {
    // Part 15: fallback to baseline on ANY intelligence-path error.
    return baseline();
  }
}
