/**
 * Search Catalog Resolver Interface & Implementations.
 *
 * Implements the acceptance criterion for Issue #44 (Phase 1B):
 * The static 40-SKU frozen universe is strictly for Phase 1A corpus parity and calibration.
 * For production runtime wiring, exact SKU and product identification must use a canonical
 * live catalog resolver rather than hardcoding static lists.
 */

export interface CatalogSkuRecord {
  sku: string;
  brand?: string;
  category?: string;
  displayName?: string;
}

export interface CatalogResolver {
  /** Check if a normalized/raw token corresponds to a known SKU. */
  hasSku(token: string): boolean | Promise<boolean>;

  /** Look up details for an exact SKU token. */
  lookupSku(token: string): CatalogSkuRecord | null | Promise<CatalogSkuRecord | null>;

  /** Return all known SKUs for entity extraction (longest first). */
  getKnownSkus(): readonly string[] | Promise<readonly string[]>;
}

/**
 * 40-SKU calibration universe from Phase 1A.
 * Preserved as an immutable fallback for offline testing, golden fixtures, and calibration.
 */
export const CALIBRATION_SKUS: readonly string[] = Object.freeze([
  'PX-80x(8MP+2MP,4mm)',
  'CS-C6N-A0-1C2WFR',
  'CS-TY1-B0-1G2WF',
  'IPC-A22EP-G-V2',
  'AC-W11',
  'ZNCLDJ11LM',
  'LLKZMK11LM',
  'MFKZQ01LM',
  'RTCGQ14LM',
  'SJCGQ11LM',
  'MCCGQ11LM',
  'QBKG12LM',
  'PS-S02D',
  'AC-S20',
  'ZNSG15LM',
  'DJT11LM',
  'MS-S02',
  'HR-21',
  'M100',
  'A100',
  'U100',
  'FP2',
  'M2',
  'M1S',
  'E1',
  'G3',
  'G2H',
  'P1',
  'S8',
  'Q7',
  'L20',
  'X40',
  'H8c',
  'C6N',
  'TY1',
  'A22',
  'A42',
  'H3c',
  'T20',
  'X10',
]);

/**
 * Static in-memory catalog resolver using the calibration universe.
 */
export class StaticCatalogResolver implements CatalogResolver {
  private readonly skuSet: Set<string>;
  private readonly sortedSkus: readonly string[];

  constructor(skus: readonly string[] = CALIBRATION_SKUS) {
    this.sortedSkus = [...skus].sort((a, b) => b.length - a.length);
    this.skuSet = new Set(this.sortedSkus.map((s) => s.toLowerCase()));
  }

  hasSku(token: string): boolean {
    return this.skuSet.has(token.toLowerCase());
  }

  lookupSku(token: string): CatalogSkuRecord | null {
    const lower = token.toLowerCase();
    const match = this.sortedSkus.find((s) => s.toLowerCase() === lower);
    if (!match) return null;
    return { sku: match };
  }

  getKnownSkus(): readonly string[] {
    return this.sortedSkus;
  }
}

/**
 * Cache-backed dynamic catalog resolver suitable for runtime injection.
 * Can be refreshed periodically or hooked into database queries without
 * modifying the parser contract.
 */
export class DynamicCatalogResolver implements CatalogResolver {
  private cache: Map<string, CatalogSkuRecord> = new Map();
  private sortedSkusCache: string[] = [];
  private lastRefreshedAt: number = 0;
  private readonly ttlMs: number;

  constructor(ttlMs: number = 300_000) {
    this.ttlMs = ttlMs;
    // Seed with calibration SKUs initially
    this.setSkus(CALIBRATION_SKUS.map((sku) => ({ sku })));
  }

  /** Update or populate live SKUs from database catalog rows. */
  setSkus(records: CatalogSkuRecord[]): void {
    this.cache.clear();
    for (const record of records) {
      this.cache.set(record.sku.toLowerCase(), record);
    }
    this.sortedSkusCache = Array.from(this.cache.values())
      .map((r) => r.sku)
      .sort((a, b) => b.length - a.length);
    this.lastRefreshedAt = Date.now();
  }

  hasSku(token: string): boolean {
    return this.cache.has(token.toLowerCase());
  }

  lookupSku(token: string): CatalogSkuRecord | null {
    return this.cache.get(token.toLowerCase()) ?? null;
  }

  getKnownSkus(): readonly string[] {
    return this.sortedSkusCache;
  }

  isStale(): boolean {
    return Date.now() - this.lastRefreshedAt > this.ttlMs;
  }
}

/** Global default resolver instance (static fallback for zero-dependency operation). */
export const defaultCatalogResolver = new StaticCatalogResolver();
