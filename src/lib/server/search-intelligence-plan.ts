/**
 * Deterministic query-understanding -> SearchPlan (Phase 1 / PR 2A).
 *
 * This is the TypeScript serving-runtime MIRROR of the Python query-understanding
 * authority in backend/search_intelligence/{vietnamese_normalizer, entity_extractor,
 * query_classifier, vocabulary}.py. The Python side is the SINGLE SOURCE OF TRUTH;
 * this module must produce the IDENTICAL intent + entities for the same query, proven
 * by the shared golden fixture backend/tests/fixtures/search_plan_golden.json (asserted
 * cross-language by search-intelligence-plan.test.ts and test_search_plan_contract.py).
 *
 * SCOPE (PR 2A): pure, in-memory, deterministic. NO DB, NO network, NO embedText, NO
 * ranking. This module is NOT wired into `/api/media` or native-search-intelligence.ts
 * -- it only produces a plan. `QueryIntent` is a 1:1 copy of Python `QueryType` (never a
 * reinvented enum); composite notions like "product+scene" or "metadata-only" are DERIVED
 * booleans, never primary intents. `route` reuses the existing BASELINE_L0 vocabulary from
 * search-intelligence-route-policy.ts rather than introducing a second routing dialect.
 *
 * Guardrail: `semanticEligible` gates the (future) semantic channel to false for exact-SKU
 * and metadata-only queries, so those never trigger an embedText call downstream.
 */

import {
  boundedExactSpanMatch,
  normalizeForMatch,
  normalizeQuery,
  stripDiacritics,
  type NormalizedQuery,
} from './search-intelligence-vn';
import type { CatalogResolver } from './search-catalog-resolver';

// ---------------------------------------------------------------------------
// QueryIntent: EXACT 1:1 mirror of Python search_intelligence QueryType
// (query_classifier.py:28-36). Same string literals so the shared fixture's
// `intent` field is one value both languages agree on. Do NOT add/remove/rename.
// ---------------------------------------------------------------------------
export enum QueryIntent {
  EXACT_SKU = 'EXACT_SKU',
  BRAND_PRODUCT = 'BRAND_PRODUCT',
  PRODUCT_CATEGORY = 'PRODUCT_CATEGORY',
  ATTRIBUTE_FEATURE = 'ATTRIBUTE_FEATURE',
  SCENE_USE_CASE = 'SCENE_USE_CASE',
  NATURAL_LANGUAGE = 'NATURAL_LANGUAGE',
  MIXED_VI_EN = 'MIXED_VI_EN',
  UNKNOWN = 'UNKNOWN',
}

/** Reuses the existing BASELINE_L0 vocabulary (search-intelligence-route-policy.ts).
 * Computed-only -- derived from intent + semanticEligible, never caller-set. */
export type SearchRoute = 'EXACT_FAST_PATH' | 'HYBRID_INTELLIGENCE' | 'BASELINE_L0';

/** Dedicated constraint bag -- deliberately NOT `MediaListParams` (never mutate that).
 * V1 only ever populates `sku` (exact SKU) and `hasPeople` (whitelisted human-absence
 * negation) as HARD constraints; brand/category/space stay soft (see softTerms). */
export interface SearchConstraints {
  sku?: string;
  brands?: string[];
  categories?: string[];
  spaces?: string[];
  hasPeople?: boolean;
  reviewStates?: string[];
}

export interface ParsedNegation {
  constraint: string;
  source: 'explicit_syntax' | 'natural_language';
  matchedText: string;
  confidence: number;
  isHard: boolean;
}

export interface EntityExtractionResult {
  skus: string[];
  brands: string[];
  categories: string[];
  spaces: string[];
  installationContexts: string[];
  features: string[];
  protocols: string[];
}

export interface SearchPlan {
  rawQuery: string;
  normalizedQuery: NormalizedQuery;
  intent: QueryIntent;
  confidence: number;
  entities: EntityExtractionResult;
  hardConstraints: SearchConstraints;
  softTerms: string[];
  negations: ParsedNegation[];
  semanticEligible: boolean;
  route: SearchRoute;
  // Derived signals (NOT primary intents) -- replace the reinvented
  // PRODUCT_SCENE/METADATA_ONLY/SCENE_ONLY types the plan originally proposed.
  hasSceneContext: boolean;
  isMetadataOnly: boolean;
}

// ===========================================================================
// Vocabulary -- transcribed verbatim from backend/search_intelligence/vocabulary.py
// (itself sourced from real repo data: migration 0008 brand taxonomy, taxonomy.ts
// DEFAULT_TAXONOMY, the frozen 40-SKU calibration_v2 universe, synonyms migration).
// If vocabulary.py changes, regenerate this block from it.
// ===========================================================================
const BRAND_VOCABULARY: readonly string[] = [
  'Acme', 'Lumos', 'Apple HomeKit',
  'Bear', 'TP-Link', 'Drift', 'EDEN', 'Imex', 'Lexar', 'Rover', 'Nova',
  'Deerma', 'Verity', 'Tera', 'Ecolo', 'Joyoung', 'SKG', 'Tabo', 'Philips',
  'Eufy', 'Govee', 'Tenda', 'Enchen', 'Hikon', 'Vconnex', 'Jisulife',
  'Tineco', 'Philips Hue', 'UGREEN', 'UVGreen', 'Mova', 'Smartmi', 'Breo',
  'Sandisk', 'AQUA', 'Lockin', 'SwitchBot', 'Lumi', 'Totolink', 'Usmile',
  'Nanoleaf', 'T3 Smart', 'Ruijie', 'Wanbo', 'D-Link', 'Ticklock', 'Anker',
  'Belkin', 'Google', 'Hoco', 'LifeSmart', '365 Selection', 'ASUS', 'Kata',
  'Acerpure', 'Goneo', 'Kioxia', 'Lumias', 'Lydsto', 'Skyworth', 'Viomi',
  'Broadlink', 'Orbit', 'Laifen', 'Mercusys', 'Acome', 'Apple', 'Botslab',
  'Chint', 'Logitech', 'Metalock', 'Reoqoo', 'Amazon', 'Arlo', 'Bomidi',
  'Ecoflow', 'JIUXUN', 'Lofans', 'Makihome', 'Mixie', 'Momoda', 'OLLI',
  'Rapoo', 'Solove', 'T3', 'Toshiba',
];

interface SkuRecord {
  sku: string;
  brand: string;
  category: string;
}

// The frozen 40-SKU universe (codes + brand + category; display_name is not needed
// for classification/extraction and is omitted). Order preserved from vocabulary.py.
const SKU_RECORDS: readonly SkuRecord[] = [
  { sku: 'HR-21', brand: 'Verity', category: 'Product_Line_A' },
  { sku: 'MT-C02-Pro', brand: 'Verity', category: 'Product_Line_A' },
  { sku: 'A1-B', brand: 'Verity', category: 'Product_Line_A' },
  { sku: 'HR-33', brand: 'Verity', category: 'Product_Line_A' },
  { sku: 'AC-S02', brand: 'ACME', category: 'Product_Line_A' },
  { sku: 'AC-S16', brand: 'ACME', category: 'Product_Line_A' },
  { sku: 'N200', brand: 'ACME', category: 'Product_Line_A' },
  { sku: 'AC-S20', brand: 'ACME', category: 'Product_Line_A' },
  { sku: 'DEMO-007', brand: 'EDEN', category: 'Product_Line_A' },
  { sku: 'DEMO-003', brand: 'EDEN', category: 'Product_Line_A' },
  { sku: 'DEMO-004', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'DEMO-013', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'DEMO-008', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'DEMO-012', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'DEMO-009', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'PX-80x(8MP+2MP,4mm)', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'DEMO-002', brand: 'EDEN', category: 'Product_Line_B' },
  { sku: 'AC-H03', brand: 'ACME', category: 'Product_Line_B' },
  { sku: 'AC-C01', brand: 'ACME', category: 'Product_Line_B' },
  { sku: 'AC-C01E', brand: 'ACME', category: 'Product_Line_B' },
  { sku: 'DEMO-017', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-016', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-015', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-018', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-019', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-020', brand: 'DRIFT', category: 'Product_Line_C' },
  { sku: 'DEMO-005', brand: 'EDEN', category: 'Product_Line_C' },
  { sku: 'Q10 VF', brand: 'ROVER', category: 'Product_Line_C' },
  { sku: 'DEMO-014', brand: 'ECOLO', category: 'Product_Line_C' },
  { sku: 'DEMO-021', brand: 'IMEX', category: 'Product_Line_C' },
  { sku: 'DEMO-006', brand: 'EDEN', category: 'Product_Line_D' },
  { sku: 'AC-D03', brand: 'ACME', category: 'Product_Line_D' },
  { sku: 'DEMO-010', brand: 'EDEN', category: 'Product_Line_D' },
  { sku: 'DEMO-011', brand: 'EDEN', category: 'Product_Line_D' },
  { sku: 'D210', brand: 'TP-LINK', category: 'Product_Line_D' },
  { sku: 'AC-G02', brand: 'ACME', category: 'Product_Line_E' },
  { sku: 'AC-G01', brand: 'ACME', category: 'Product_Line_E' },
  { sku: 'M300', brand: 'Verity', category: 'Product_Line_E' },
  { sku: 'DEMO-022', brand: 'TABO', category: 'Product_Line_E' },
  { sku: 'AC-W11', brand: 'ACME', category: 'Product_Line_E' },
];

// Fast exact lookup: normalized (casefold + collapsed whitespace) SKU code -> record.
const SKU_INDEX: ReadonlyMap<string, SkuRecord> = new Map(
  SKU_RECORDS.map((record) => [normalizeForMatch(record.sku), record]),
);
// Longest key first so a longer real SKU ("DEMO-016") wins over a shorter substring.
const SKU_KEYS_BY_LENGTH: readonly string[] = [...SKU_INDEX.keys()].sort(
  (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
);

const CATEGORY_KEYWORDS: ReadonlyArray<readonly [string, string]> = [
  ['khóa', 'Product_Line_A'],
  ['khoá', 'Product_Line_A'],
  ['camera', 'Product_Line_B'],
  ['robot hút bụi', 'Product_Line_C'],
  ['chuông cửa', 'Product_Line_D'],
  ['hub', 'Product_Line_E'],
  ['cảm biến', 'Product_Line_E'],
  ['rèm', 'Curtains'],
  ['rem', 'Curtains'],
];

const SPACE_VOCABULARY: readonly string[] = [
  'Phòng khách', 'Bếp', 'Cửa chính', 'Phòng ngủ', 'Toàn cảnh',
  'Sân vườn', 'Ban công', 'Cầu thang', 'Gara', 'Phòng thờ',
];

const INSTALLATION_CONTEXT_VOCABULARY: readonly string[] = ['trong nhà', 'ngoài trời'];
const PROTOCOL_VOCABULARY: readonly string[] = ['zigbee', 'wifi'];
const FEATURE_VOCABULARY: readonly string[] = ['vân tay', 'quay quét', 'face id', 'pin'];

// ASCII function/adjective markers -- purely a heuristic NL-confidence signal, checked
// against folded tokens exactly like the Python authority (query_classifier.py:25). Note
// the same quirk: accented markers can never match a folded token, so in practice only
// "cho"/"voi" ever fire -- and this affects confidence/signals only, never the intent.
const VIETNAMESE_NL_MARKERS: readonly string[] = ['cho', 'nào', 'gì', 'loại', 'nhất', 'hơn', 'voi', 'với'];

// ---------------------------------------------------------------------------
// Entity extraction -- mirrors entity_extractor.py (boundary-respecting exact
// match against the frozen vocabularies; accented haystack first, folded fallback).
// SKU detection is an exact index lookup, never a regex (see vocabulary.py SKU_INDEX).
// ---------------------------------------------------------------------------
/** One matched entity, carrying both its canonical value and the query surface that
 * matched (the vocab phrase). `matchedText` is needed to locate the entity's token for
 * negation scoping -- for categories the value (e.g. "Product_Line_A") is NOT the matched
 * surface ("khóa"), so value alone cannot be found among the query tokens. */
interface PhraseMatch {
  value: string;
  matchedText: string;
}

function matchPhrasesDetailed(
  normalized: NormalizedQuery,
  entries: ReadonlyArray<readonly [string, string]>,
): PhraseMatch[] {
  const accentedHaystack = normalizeForMatch(normalized.accentedNormalized);
  const foldedHaystack = normalizeForMatch(normalized.accentFolded);
  const matches: PhraseMatch[] = [];
  const seen = new Set<string>();
  for (const [phrase, value] of entries) {
    if (seen.has(value)) continue;
    const phraseNorm = normalizeForMatch(phrase);
    if (!phraseNorm) continue;
    if (boundedExactSpanMatch(phraseNorm, accentedHaystack)) {
      matches.push({ value, matchedText: phrase });
      seen.add(value);
      continue;
    }
    const foldedPhrase = normalizeForMatch(stripDiacritics(phrase));
    if (foldedPhrase && boundedExactSpanMatch(foldedPhrase, foldedHaystack)) {
      matches.push({ value, matchedText: phrase });
      seen.add(value);
    }
  }
  return matches;
}

const asPairs = (vocab: readonly string[]): ReadonlyArray<readonly [string, string]> =>
  vocab.map((entry) => [entry, entry] as const);

function findSkuMatches(normalized: NormalizedQuery, catalogResolver?: CatalogResolver): string[] {
  const haystack = normalizeForMatch(normalized.accentedNormalized);
  if (!haystack) return [];
  const skus: string[] = [];

  if (catalogResolver) {
    const rawKeys = catalogResolver.getKnownSkus();
    const keys = Array.isArray(rawKeys) ? rawKeys : SKU_KEYS_BY_LENGTH;
    for (const rawKey of keys) {
      const normKey = normalizeForMatch(rawKey);
      if (normKey && boundedExactSpanMatch(normKey, haystack)) {
        const record = catalogResolver.lookupSku(rawKey);
        if (record && typeof record === 'object' && 'sku' in record) {
          skus.push(record.sku);
        } else {
          skus.push(rawKey);
        }
      }
    }
    return skus;
  }

  // NOTE: mirrors Python _boundary_pattern; boundedExactSpanMatch enforces a non-alnum
  // boundary on BOTH sides, a hair stricter than Python for a key ending in punctuation
  // immediately followed by an alnum char -- not reachable for the frozen SKU set.
  for (const key of SKU_KEYS_BY_LENGTH) {
    if (boundedExactSpanMatch(key, haystack)) {
      const record = SKU_INDEX.get(key);
      if (record) skus.push(record.sku);
    }
  }
  return skus;
}

/** Detailed extraction (values + matched surfaces) -- the internal form negation scoping
 * needs. `extractEntities` projects this down to the value-only public shape. */
interface DetailedEntities {
  skus: string[];
  brands: PhraseMatch[];
  categories: PhraseMatch[];
  spaces: PhraseMatch[];
  installationContexts: PhraseMatch[];
  features: PhraseMatch[];
  protocols: PhraseMatch[];
}

function extractEntitiesDetailed(
  normalized: NormalizedQuery,
  catalogResolver?: CatalogResolver,
): DetailedEntities {
  return {
    skus: findSkuMatches(normalized, catalogResolver),
    brands: matchPhrasesDetailed(normalized, asPairs(BRAND_VOCABULARY)),
    categories: matchPhrasesDetailed(normalized, CATEGORY_KEYWORDS),
    spaces: matchPhrasesDetailed(normalized, asPairs(SPACE_VOCABULARY)),
    installationContexts: matchPhrasesDetailed(normalized, asPairs(INSTALLATION_CONTEXT_VOCABULARY)),
    features: matchPhrasesDetailed(normalized, asPairs(FEATURE_VOCABULARY)),
    protocols: matchPhrasesDetailed(normalized, asPairs(PROTOCOL_VOCABULARY)),
  };
}

function projectEntities(detailed: DetailedEntities): EntityExtractionResult {
  return {
    skus: detailed.skus,
    brands: detailed.brands.map((m) => m.value),
    categories: detailed.categories.map((m) => m.value),
    spaces: detailed.spaces.map((m) => m.value),
    installationContexts: detailed.installationContexts.map((m) => m.value),
    features: detailed.features.map((m) => m.value),
    protocols: detailed.protocols.map((m) => m.value),
  };
}

export function extractEntities(
  normalized: NormalizedQuery,
  catalogResolver?: CatalogResolver,
): EntityExtractionResult {
  return projectEntities(extractEntitiesDetailed(normalized, catalogResolver));
}

// ---------------------------------------------------------------------------
// Classification -- the fixed 8-step precedence from RuleBasedQueryClassifier
// (query_classifier.py:90-151), mirrored branch-for-branch.
// ---------------------------------------------------------------------------
export interface Classification {
  intent: QueryIntent;
  confidence: number;
  signals: string[];
}

function hasAccentedVietnamese(normalized: NormalizedQuery): boolean {
  return normalized.accentedNormalized !== normalized.accentFolded;
}

function hasAsciiAlphaToken(normalized: NormalizedQuery): boolean {
  // Python: token.isascii() and token.isalpha() and len >= 2.
  return normalized.tokens.some((token) => /^[A-Za-z]{2,}$/.test(token));
}

export function classify(normalized: NormalizedQuery, entities: EntityExtractionResult): Classification {
  if (normalized.tokens.length === 0) {
    return { intent: QueryIntent.UNKNOWN, confidence: 1.0, signals: ['empty_query'] };
  }
  if (entities.skus.length > 0) {
    return { intent: QueryIntent.EXACT_SKU, confidence: 1.0, signals: entities.skus.map((s) => `sku:${s}`) };
  }
  if (entities.brands.length > 0 && (entities.categories.length > 0 || normalized.tokens.length >= 2)) {
    return {
      intent: QueryIntent.BRAND_PRODUCT,
      confidence: entities.categories.length > 0 ? 0.9 : 0.75,
      signals: [
        ...entities.brands.map((b) => `brand:${b}`),
        ...entities.categories.map((c) => `category:${c}`),
      ],
    };
  }
  if (entities.spaces.length > 0 || entities.installationContexts.length > 0) {
    return {
      intent: QueryIntent.SCENE_USE_CASE,
      confidence: entities.categories.length > 0 || entities.features.length > 0 ? 0.85 : 0.8,
      signals: [
        ...entities.spaces.map((s) => `space:${s}`),
        ...entities.installationContexts.map((c) => `install_context:${c}`),
        ...entities.categories.map((c) => `category:${c}`),
        ...entities.features.map((f) => `feature:${f}`),
      ],
    };
  }
  if (entities.categories.length > 0 && entities.brands.length === 0) {
    return {
      intent: QueryIntent.PRODUCT_CATEGORY,
      confidence: 0.85,
      signals: entities.categories.map((c) => `category:${c}`),
    };
  }
  if (
    (entities.features.length > 0 || entities.protocols.length > 0)
    && entities.categories.length === 0
    && entities.brands.length === 0
  ) {
    return {
      intent: QueryIntent.ATTRIBUTE_FEATURE,
      confidence: 0.8,
      signals: [
        ...entities.features.map((f) => `feature:${f}`),
        ...entities.protocols.map((p) => `protocol:${p}`),
      ],
    };
  }
  if (hasAccentedVietnamese(normalized) && hasAsciiAlphaToken(normalized)) {
    return {
      intent: QueryIntent.MIXED_VI_EN,
      confidence: 0.6,
      signals: ['has_accented_vietnamese_token', 'has_ascii_alpha_token'],
    };
  }
  if (normalized.tokens.length >= 4) {
    const markers = VIETNAMESE_NL_MARKERS.filter((m) => normalized.foldedTokens.includes(m));
    return {
      intent: QueryIntent.NATURAL_LANGUAGE,
      confidence: markers.length > 0 ? 0.65 : 0.5,
      signals: ['token_count>=4', ...markers.map((m) => `nl_marker:${m}`)],
    };
  }
  return { intent: QueryIntent.UNKNOWN, confidence: 0.3, signals: ['no_signal_matched'] };
}

// ---------------------------------------------------------------------------
// Negation parsing -- V1 whitelist. Only unambiguous human-absence phrases become a
// HARD constraint (hasPeople=false); every other negated entity stays SOFT.
// ---------------------------------------------------------------------------
const NEGATION_CUES: ReadonlySet<string> = new Set(['khong', 'ko', 'chua']);
// Whitelisted human-absence phrases, in accent-folded form (matched against accentFolded).
const HUMAN_ABSENCE_FOLDED: readonly string[] = [
  'khong co nguoi', 'ko co nguoi', 'khong nguoi', 'no people', 'without people',
];

/** Token index (into folded tokens) of an entity's first folded word, or -1. */
function entityTokenIndex(foldedTokens: readonly string[], matchedText: string): number {
  const head = stripDiacritics(matchedText).toLowerCase().split(/\s+/).filter(Boolean)[0];
  return head === undefined ? -1 : foldedTokens.indexOf(head);
}

export interface BuildSearchPlanOptions {
  catalogResolver?: CatalogResolver;
}

export function buildSearchPlan(rawQuery: string, options?: BuildSearchPlanOptions): SearchPlan {
  const normalized = normalizeQuery(rawQuery);
  const detailed = extractEntitiesDetailed(normalized, options?.catalogResolver);
  const entities = projectEntities(detailed);
  const classification = classify(normalized, entities);
  const { intent } = classification;

  const hasSpaceEntity = entities.spaces.length > 0 || entities.installationContexts.length > 0;
  const hasSceneContext =
    intent === QueryIntent.SCENE_USE_CASE || (intent === QueryIntent.BRAND_PRODUCT && hasSpaceEntity);
  const tokenCount = normalized.tokens.length;
  const isMetadataOnly =
    (intent === QueryIntent.BRAND_PRODUCT || intent === QueryIntent.PRODUCT_CATEGORY)
    && !hasSceneContext
    && tokenCount <= 3;

  const semanticEligible = !(intent === QueryIntent.EXACT_SKU || isMetadataOnly);
  const route: SearchRoute =
    intent === QueryIntent.EXACT_SKU
      ? 'EXACT_FAST_PATH'
      : !semanticEligible
        ? 'BASELINE_L0'
        : 'HYBRID_INTELLIGENCE';

  const hardConstraints: SearchConstraints = {};
  if (entities.skus.length > 0) {
    hardConstraints.sku = entities.skus[0];
  }

  const negations: ParsedNegation[] = [];
  const folded = normalized.accentFolded;
  for (const phrase of HUMAN_ABSENCE_FOLDED) {
    const idx = folded.indexOf(phrase);
    if (idx !== -1) {
      hardConstraints.hasPeople = false;
      // Accent folding is length-preserving for these VN phrases, so the same slice of
      // the accented form recovers the human-readable matched text.
      const matchedText = normalized.accentedNormalized.slice(idx, idx + phrase.length);
      negations.push({
        constraint: 'hasPeople',
        source: 'natural_language',
        matchedText,
        confidence: 1.0,
        isHard: true,
      });
      break;
    }
  }

  const softSet = new Set<string>([
    ...entities.brands,
    ...entities.categories,
    ...entities.spaces,
    ...entities.installationContexts,
    ...entities.features,
    ...entities.protocols,
  ]);
  const cueIndex = normalized.foldedTokens.findIndex((token) => NEGATION_CUES.has(token));
  if (cueIndex !== -1) {
    const groups: Array<[PhraseMatch[], string]> = [
      [detailed.brands, 'brand'],
      [detailed.categories, 'category'],
    ];
    for (const [group, label] of groups) {
      for (const match of group) {
        // Locate the entity by its matched SURFACE (e.g. "khóa"), not its canonical
        // value (e.g. "Product_Line_A") which never appears among the query tokens.
        const ti = entityTokenIndex(normalized.foldedTokens, match.matchedText);
        if (ti !== -1 && ti > cueIndex) {
          negations.push({
            constraint: `${label}:${match.value}`,
            source: 'natural_language',
            matchedText: match.value,
            confidence: 0.5,
            isHard: false,
          });
          softSet.delete(match.value);
        }
      }
    }
  }
  const softTerms = [...softSet].sort();

  return {
    rawQuery,
    normalizedQuery: normalized,
    intent,
    confidence: classification.confidence,
    entities,
    hardConstraints,
    softTerms,
    negations,
    semanticEligible,
    route,
    hasSceneContext,
    isMetadataOnly,
  };
}
