/**
 * Phase 2C -- Hash-Based Canary Traffic Allocator.
 *
 * Deterministically routes a bounded, gradually-ramped fraction of production
 * traffic to the intelligent search path while every other request continues
 * to be served by BASELINE_L0. The allocation is:
 *   - Deterministic per identifier (same user always lands in the same bucket
 *     at a given percentage), so a user's experience is stable within a stage.
 *   - Uniform across identifiers (SHA-256 of the identifier, first 32 bits),
 *     so a target percentage is honored to within measurement noise.
 *
 * GOVERNANCE (see docs/search/PHASE_2B_2C_STRONG_AGENT_BRIEF.md):
 *   - Default is 0% (fail-closed). Ramp stages 5% -> 25% -> 100% are an
 *     operational decision that MUST NOT be enabled until Gate #41 (Q0-C) has
 *     passed AND Phase 2A shadow telemetry + Gold #42 grades confirm the
 *     intelligent path is at least as good as baseline. This module only
 *     decides membership; it never tunes anything.
 *   - Any invalid/malformed configuration collapses to 0% (baseline only).
 *   - This module performs NO search and NO I/O; the caller is responsible for
 *     wrapping the intelligent path in a baseline fallback on ANY exception.
 */

import { createHash } from 'node:crypto';

import type { FlagEnvSource } from './search-intelligence-flag';

export const CANARY_PERCENT_ENV = 'VERITY_SEARCH_CANARY_PERCENT';

/**
 * Parse and clamp the configured canary percentage.
 * Fail-closed: anything that is not a finite integer in [0, 100] becomes 0.
 * Fractional values are floored (a value of "5.9" is treated as 5%).
 */
export function getSearchCanaryPercent(env: FlagEnvSource = process.env): number {
  const raw = env[CANARY_PERCENT_ENV];
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  const floored = Math.floor(parsed);
  if (floored <= 0) return 0;
  if (floored >= 100) return 100;
  return floored;
}

/**
 * Deterministic membership test. Mirrors the reference implementation in the
 * engineering brief exactly: SHA-256 of the identifier, first big-endian
 * UInt32, modulo 100.
 *
 * Fail-closed: an empty/whitespace-only identifier or a non-positive
 * percentage yields false (baseline). A percentage >= 100 yields true.
 */
export function isUserInCanary(identifier: string, canaryPercent: number): boolean {
  if (canaryPercent <= 0) return false;
  if (canaryPercent >= 100) return true;
  if (typeof identifier !== 'string' || identifier.trim().length === 0) return false;
  const hash = createHash('sha256').update(identifier).digest().readUInt32BE(0);
  return hash % 100 < canaryPercent;
}

/**
 * Convenience gate combining env-configured percentage with the identifier.
 * Returns true only when the caller should attempt the intelligent path.
 * Fail-closed by construction (invalid config -> 0% -> false).
 */
export function shouldServeCanaryIntelligence(
  identifier: string,
  env: FlagEnvSource = process.env,
): boolean {
  return isUserInCanary(identifier, getSearchCanaryPercent(env));
}
