/**
 * R0.1 production search-intelligence orchestrator (mission
 * S.SEARCH-2.1, "STUDIO R0.1 PRODUCTION INTEGRATION").
 *
 * This is the ONLY file that ties the pure logic modules
 * (search-intelligence-vn/exact/lexical/fusion/semantic/recovery/fuzzy)
 * to real, permission-filtered SQL candidate retrieval. It never touches
 * `native-media.ts`'s baseline query shape or column list beyond reusing
 * its exported, shared predicate builders -- Item 7 (identical
 * permission/filter predicates on both paths) is satisfied by
 * construction, not by parallel-but-equivalent code.
 *
 * Architectural note (documented in the mission's judgment-calls
 * paragraph): candidate retrieval and zero-result recovery are the SAME
 * sequenced stage list (Item 2 + Item 8 unified). "Stage A" (exact
 * SKU / high-precision entity recall) is folded into stage 1
 * (ORIGINAL_ACCENTED_LEXICAL) rather than added as a 6th recovery stage,
 * because RecoveryStage (Mission 2) already fixes the 5-stage
 * enumeration and exact-SKU rows must never be dropped just because a
 * broader lexical query answers the same request.
 *
 * SigLIP2 / any real semantic retriever is NOT invoked here --
 * nullSemanticRetriever always returns no hits, but every call site still
 * routes through validateSemanticHits() (Item 3), so a future real
 * retriever plugs in without a caller change.
 */

import type { MediaListParams } from '@/lib/media-api';
import type { MediaAsset } from '@/types/media';
import {
  buildEligibilityWhere,
  buildIlikeTermCondition,
  resolveMediaUrls,
  type NativeMediaListOptions,
  type Row,
} from './native-media';
import { mapMediaAsset } from './media-mapper';
import { requireNativeDatabase } from './native-db';
import { expandSearchTerms, getNativeSynonymsConfig } from './native-synonyms';
import { normalizeQuery, normalizeForMatch, stripDiacritics, escapeIlikeTerm, type NormalizedQuery } from './search-intelligence-vn';
import {
  anyExact,
  computeExactSignals,
  rankTier,
  type ExactSignals,
  type SearchDocumentLite,
} from './search-intelligence-exact';
import { scoreDocument, type LexicalScore } from './search-intelligence-lexical';
import { correctQueryTokens, MAX_EDIT_DISTANCE, type TokenCorrection } from './search-intelligence-fuzzy';
import {
  reciprocalRankFusion,
  rerank,
  SEMANTIC_DEPTH,
  type RankedChannelHit,
  type RerankCandidate,
} from './search-intelligence-fusion';
import { loadSearchConfig } from './search-config';
import {
  nullSemanticRetriever,
  validateSemanticHits,
  type SemanticRetriever,
  PostgresSiglip2SemanticRetriever,
} from './search-intelligence-semantic';
import { recoverZeroResult, RecoveryStage } from './search-intelligence-recovery';
import { isSearchCatalogV1Enabled, isSearchMmrV1Enabled } from './search-intelligence-flag';
import { resolveProductSafeAssetIds } from './search-catalog-db';
import { mmrDiversify, type MmrCandidate } from './search-intelligence-mmr';
import { buildSearchPlan } from './search-intelligence-plan';

/**
 * Item 1: a separately-bounded raw query for the intelligence path only.
 * parseMediaListParams()'s punctuation stripping (media-api.ts) is left
 * untouched for the baseline path. This preserves the punctuation real
 * SKUs use ("PX-80x(8MP+2MP,4mm)", "DEMO-002") while still
 * rejecting control characters/newlines and bounding length. Never used
 * to build a string-interpolated SQL fragment -- always passed as a bound
 * parameter.
 */
const SAFE_QUERY_CHARACTERS_RE = /[^\p{L}\p{N}\s*_()+,./-]/gu;
const WHITESPACE_RE = /\s+/g;
const MAX_RAW_QUERY_LENGTH = 120;

export function parseIntelligenceRawQuery(searchParams: URLSearchParams): string {
  const raw = (searchParams.get('q') || '').trim();
  return raw
    .replace(SAFE_QUERY_CHARACTERS_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim()
    .slice(0, MAX_RAW_QUERY_LENGTH);
}

/**
 * Item 10: thrown instead of ever exposing partial ranking as complete.
 * The gateway (search-intelligence-gateway.ts) catches ANY thrown error
 * from the intelligence path and falls back to BASELINE_L0 -- this class
 * exists purely so the internal reason can be logged server-side
 * (Item 14) before that fallback happens.
 */
export class IntelligenceFallbackError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'IntelligenceFallbackError';
    this.reason = reason;
  }
}

/** Item 10: safe candidate-population cap. Exceeding it fails safely to
 * baseline (option B) rather than attempting deterministic narrowing --
 * a disclosed, conservative scope choice (see final report). */
export const CANDIDATE_POOL_SAFE_CAP = 500;

/** Minimal shape the orchestrator needs from a pg Pool -- lets tests
 * inject a fixture/mock pool (Item 17) without a real Postgres instance. */
export interface QueryablePool {
  query<T = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface IntelligenceDeps {
  pool?: QueryablePool;
  /** Injectable override for the REVIEWED_SYNONYMS stage's data source
   * (defaults to the real, cached `getNativeSynonymsConfig()`). Lets
   * fixture/mock-DB integration tests (Item 17) exercise every recovery
   * stage without a real Postgres connection. */
  synonymsProvider?: () => Promise<Awaited<ReturnType<typeof getNativeSynonymsConfig>>>;
  /** Injectable override for semantic search retrieval (defaults to PostgresSiglip2SemanticRetriever). */
  semanticRetriever?: SemanticRetriever;
  /** Explicit caller override to enable semantic retrieval when lexical recovery is EXHAUSTED.
   * Note: semantic-eligible queries automatically proceed to semantic retrieval on EXHAUSTED,
   * while this flag allows callers (e.g., shadow evaluation) to force semantic rescue regardless of intent. */
  enableSemanticOnExhausted?: boolean;
  /** Injectable override for product-safe asset resolution (defaults to resolveProductSafeAssetIds with real DB pool). */
  resolveProductSafeAssetIds?: (token: string) => Promise<Set<string>>;
  /** Injectable override for candidate embedding resolution (defaults to querying public.asset_embeddings). */
  fetchCandidateEmbeddings?: (assetIds: readonly string[]) => Promise<Map<string, readonly number[]>>;
}

function buildIlikeAnyCondition(terms: readonly string[], values: unknown[]): string {
  const patterns = terms.map((term) => `%${escapeIlikeTerm(term)}%`);
  const index = values.push(patterns);
  // ANY(array) form uses Postgres's default backslash escape character for
  // ILIKE, which is exactly what escapeIlikeTerm() escapes against -- no
  // explicit ESCAPE clause is valid/needed on this operator form.
  return `(a.title ilike any($${index}::text[]) or a.sku ilike any($${index}::text[]) or a.brand ilike any($${index}::text[]) or a.category ilike any($${index}::text[]) or a.space ilike any($${index}::text[]) or a.suggested_caption ilike any($${index}::text[]) or a.description ilike any($${index}::text[]) or exists (select 1 from unnest(a.keywords) keyword where keyword ilike any($${index}::text[])))`;
}

async function fetchCandidateRows(
  pool: QueryablePool,
  baseWhere: readonly string[],
  condition: string,
  values: unknown[],
  cap: number,
): Promise<Row[]> {
  const where = [...baseWhere, condition];
  const limitIndex = values.push(cap + 1);
  const query = `
    select a.*,
      exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review')) as has_open_report,
      coalesce((select jsonb_agg(u order by u.used_at desc) from public.media_usages u where u.media_asset_id = a.id), '[]'::jsonb) as media_usages
    from public.media_assets a where ${where.join(' and ')} limit $${limitIndex}`;
  const result = await pool.query<Row>(query, values);
  if (result.rows.length > cap) {
    throw new IntelligenceFallbackError(
      'CANDIDATE_POOL_TOO_LARGE_FALLBACK',
      `intelligence candidate pool exceeded safe cap of ${cap}`,
    );
  }
  return result.rows;
}

async function fetchEmbeddingsFromDb(
  pool: QueryablePool,
  assetIds: readonly string[],
): Promise<Map<string, readonly number[]>> {
  if (assetIds.length === 0) return new Map();
  const sql = `
    SELECT asset_id, vector
    FROM public.asset_embeddings
    WHERE kind = 'global'
      AND space_id = (SELECT nl_search_space_id FROM public.embedding_runtime_state WHERE singleton_id = 1 LIMIT 1)
      AND asset_id = ANY($1::uuid[])
  `;
  try {
    const result = await pool.query<{ asset_id: string; vector: unknown }>(sql, [assetIds]);
    const map = new Map<string, readonly number[]>();
    for (const row of result.rows) {
      let vec: number[];
      if (Array.isArray(row.vector)) {
        vec = row.vector.map(Number);
      } else if (typeof row.vector === 'string') {
        vec = row.vector.replace(/[\[\]]/g, '').split(',').map(Number);
      } else {
        continue;
      }
      map.set(String(row.asset_id), vec);
    }
    return map;
  } catch {
    return new Map();
  }
}

function toSearchDocumentLite(row: Row): SearchDocumentLite {
  return {
    assetId: String(row.id ?? ''),
    title: typeof row.title === 'string' ? row.title : '',
    sku: typeof row.sku === 'string' ? row.sku : '',
    brand: typeof row.brand === 'string' ? row.brand : '',
    category: typeof row.category === 'string' ? row.category : '',
    space: typeof row.space === 'string' ? row.space : '',
    suggestedCaption: typeof row.suggested_caption === 'string' ? row.suggested_caption : '',
    description: typeof row.description === 'string' ? row.description : '',
    keywords: Array.isArray(row.keywords) ? row.keywords.filter((keyword: unknown): keyword is string => typeof keyword === 'string') : [],
    usageCount: typeof row.usage_count === 'number' ? row.usage_count : Number(row.usage_count) || 0,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
  };
}

function entityOverlapCount(signals: ExactSignals): number {
  return Number(signals.exactSku) + Number(signals.exactBrandModel) + Number(signals.exactTitlePhrase) + Number(signals.exactBrand);
}

/** Bounded, disclosed approximation: a document gets fuzzy evidence only
 * if one of the (already-capped) corrected tokens appears literally in
 * its own text. Not a byte-for-byte port of the Python typo model's
 * weighted confidence -- see search-intelligence-fuzzy.ts's scope note. */
function computeFuzzyConfidence(document: SearchDocumentLite, corrections: readonly TokenCorrection[]): number {
  if (corrections.length === 0) return 0;
  const haystack = normalizeForMatch(
    stripDiacritics([document.title, document.brand, document.category, document.space, document.suggestedCaption, document.keywords.join(' ')].join(' ')),
  );
  let best = 0;
  for (const correction of corrections) {
    if (haystack.includes(correction.correctedToken)) {
      const confidence = 1 - correction.editDistance / (MAX_EDIT_DISTANCE + 1);
      if (confidence > best) best = confidence;
    }
  }
  return best;
}

/** Aggregated, truthful signal about what kind of exact match this query
 * produced across the candidate pool -- NOT which specific SKU/brand
 * string matched (that would require plumbing a concrete document
 * reference through to the route layer for little benefit). Consumed by
 * /api/media's search_meta so the FE can show what the search engine
 * actually did instead of a fabricated, hardcoded interpretation. */
export interface DetectedEntitySignals {
  exactSku: boolean;
  exactBrand: boolean;
  exactBrandModel: boolean;
  exactTitlePhrase: boolean;
}

const NO_DETECTED_ENTITIES: DetectedEntitySignals = {
  exactSku: false,
  exactBrand: false,
  exactBrandModel: false,
  exactTitlePhrase: false,
};

export interface IntelligentSearchResult {
  data: MediaAsset[];
  total: number;
  recoveryStageUsed: RecoveryStage;
  /** True only if the semantic retriever actually returned >= 1 validated
   * hit this request -- never true while SigLIP2/nl_search_space_id stays
   * inactive (see search-intelligence-semantic.ts). Must gate any "semantic
   * search" UI claim; the retriever being merely *callable* is not enough. */
  semanticActive: boolean;
  semanticHitAssetIds?: string[];
  resultScoresById?: Record<string, number>;
  detectedEntities: DetectedEntitySignals;
}

/**
 * The R0.1 intelligence candidate-retrieval + ranking path. Never called
 * directly by the route unless the feature flag is true AND the request
 * is eligible (Items 12/13) -- see route.ts's gateway wiring.
 *
 * Order of operations (Item 11): permission/filter -> candidate
 * retrieval (sequenced stages, Item 8) -> reranking -> page slice. The
 * SQL LIMIT/OFFSET the baseline path uses is NEVER applied here before
 * ranking.
 */
export async function listNativeLibraryMediaIntelligent(
  params: MediaListParams,
  rawQuery: string,
  options: NativeMediaListOptions = {},
  deps: IntelligenceDeps = {},
): Promise<IntelligentSearchResult> {
  const normalized: NormalizedQuery = normalizeQuery(rawQuery);
  if (!normalized.normalizedWhitespace) {
    throw new IntelligenceFallbackError('EMPTY_INTELLIGENCE_QUERY', 'intelligence path requires a non-empty query');
  }

  const pool: QueryablePool = deps.pool ?? requireNativeDatabase();

  // Item 7: identical permission/filter predicate as the baseline path,
  // built once and cloned per stage attempt (parameter indices must not
  // collide across the sequenced retrieval stages).
  const baseValues: unknown[] = [];
  const baseWhere = buildEligibilityWhere(params, baseValues, options);

  const corrections = correctQueryTokens(normalized.foldedTokens);
  // Deliberately NOT invoked eagerly: earlier stages routinely make this
  // call unnecessary (a stage before REVIEWED_SYNONYMS already satisfied
  // recovery, or threw a CANDIDATE_POOL_TOO_LARGE_FALLBACK) -- calling it
  // here regardless would fire a real, possibly-unconfigured-in-tests DB
  // query whose rejection nothing would ever await.
  const fetchSynonyms = deps.synonymsProvider ?? getNativeSynonymsConfig;

  const recovery = await recoverZeroResult<Row>({
    // Stage 1 = "Stage A" (exact SKU / high-precision recall, via a
    // literal, non-wildcard substring check of the document's own SKU
    // inside the raw query) UNIONed with "Stage B" (original lexical,
    // same field list/escaping as baseline) -- both answer
    // ORIGINAL_ACCENTED_LEXICAL so an exact-SKU row is never missed just
    // because a broader lexical stage would also have matched.
    [RecoveryStage.ORIGINAL_ACCENTED_LEXICAL]: async () => {
      const values = [...baseValues];
      const skuParamIndex = values.push(normalized.normalizedWhitespace);
      const lexicalCondition = buildIlikeTermCondition(normalized.normalizedWhitespace, values);
      const condition = `((a.sku <> '' and position(lower(a.sku) in $${skuParamIndex}) > 0) or ${lexicalCondition})`;
      return fetchCandidateRows(pool, baseWhere, condition, values, CANDIDATE_POOL_SAFE_CAP);
    },
    // Stage C: bounded token-group OR-matching over both accented and
    // accent-folded token forms -- a high-recall net; TRUE accent-fold
    // precision comparison happens in-process against the real fetched
    // text (search-intelligence-lexical.ts / search-intelligence-exact.ts).
    [RecoveryStage.ACCENT_FOLDED_LEXICAL]: async () => {
      const tokens = [...new Set([...normalized.tokens, ...normalized.foldedTokens])].filter((token) => token.length >= 2).slice(0, 16);
      if (tokens.length === 0) return [];
      const values = [...baseValues];
      const condition = buildIlikeAnyCondition(tokens, values);
      return fetchCandidateRows(pool, baseWhere, condition, values, CANDIDATE_POOL_SAFE_CAP);
    },
    // Stage D: bounded, corpus-driven typo correction (search-intelligence-fuzzy.ts).
    [RecoveryStage.BOUNDED_FUZZY_CORRECTION]: async () => {
      if (corrections.length === 0) return [];
      const values = [...baseValues];
      const condition = buildIlikeAnyCondition(corrections.map((correction) => correction.correctedToken), values);
      return fetchCandidateRows(pool, baseWhere, condition, values, CANDIDATE_POOL_SAFE_CAP);
    },
    // Stage E: the existing, human-curated production synonym table.
    [RecoveryStage.REVIEWED_SYNONYMS]: async () => {
      const synonyms = await fetchSynonyms();
      const terms = expandSearchTerms(normalized.normalizedWhitespace, synonyms).filter(Boolean);
      if (terms.length === 0) return [];
      const values = [...baseValues];
      const condition = buildIlikeAnyCondition(terms, values);
      return fetchCandidateRows(pool, baseWhere, condition, values, CANDIDATE_POOL_SAFE_CAP);
    },
    // Semantic retrieval is intentionally performed after lexical recovery so
    // semantic-eligible zero-lexical queries can use the active SigLIP2 space.
  });

  const searchConfig = await loadSearchConfig();

  // Auto-routing & Semantic Eligibility Gate:
  // 1. If admin disabled semantic search in SearchConfigSettings, bypass semantic retriever completely.
  // 2. If query is exact SKU or short brand metadata (!plan.semanticEligible), route directly to
  //    fast lexical/exact (<5ms) and skip text embedding to avoid wasting inference resources.
  let isSemanticEligible = searchConfig.semantic_enabled;
  if (isSemanticEligible && !deps.semanticRetriever) {
    try {
      const plan = buildSearchPlan(rawQuery);
      isSemanticEligible = plan.semanticEligible;
    } catch {
      // Retain default eligibility if plan parsing encounters unknown grammar
    }
  }

  // If lexical recovery is exhausted and query is NOT semantic eligible, return honest zero-result immediately.
  if (recovery.recoveryStageUsed === RecoveryStage.EXHAUSTED && !isSemanticEligible && !deps.enableSemanticOnExhausted) {
    // Item 2: honest zero-result on default SERVE path. Never asset-id-ordered noise.
    return {
      data: [],
      total: 0,
      recoveryStageUsed: RecoveryStage.EXHAUSTED,
      semanticActive: false,
      detectedEntities: NO_DETECTED_ENTITIES,
    };
  }

  const candidateRows = recovery.candidates;
  const documents = candidateRows.map(toSearchDocumentLite);

  // Item 3: semantic output is ALWAYS validated before fusion.
  const retriever =
    deps.semanticRetriever ??
    (isSemanticEligible && pool
      ? new PostgresSiglip2SemanticRetriever(pool, { canSeeInternal: options.canSeeInternal })
      : nullSemanticRetriever);
  const semanticHits = validateSemanticHits(await retriever.retrieve(normalized.normalizedWhitespace, SEMANTIC_DEPTH));
  const semanticRanked: RankedChannelHit[] = semanticHits.map((hit) => ({ assetId: hit.assetId, rank: hit.semanticRank }));
  const semanticRankById = new Map(semanticRanked.map((hit) => [hit.assetId, hit.rank]));

  const effectiveRecoveryStage = recovery.recoveryStageUsed === RecoveryStage.EXHAUSTED && semanticHits.length > 0
    ? RecoveryStage.FUTURE_SEMANTIC_CHANNEL
    : recovery.recoveryStageUsed;

  // Merge semantic hits into candidateRows & documents if not already present
  const existingCandidateIds = new Set(candidateRows.map((r) => String(r.id)));
  const missingSemanticIds = semanticHits
    .map((h) => h.assetId)
    .filter((id) => !existingCandidateIds.has(id));

  if (missingSemanticIds.length > 0 && pool) {
    const missingValues = [...baseValues];
    const idParamIndex = missingValues.push(missingSemanticIds);
    const missingCondition = `a.id = ANY($${idParamIndex}::uuid[])`;
    try {
      const semanticRows = await fetchCandidateRows(pool, baseWhere, missingCondition, missingValues, missingSemanticIds.length);
      for (const row of semanticRows) {
        if (!existingCandidateIds.has(String(row.id))) {
          candidateRows.push(row);
          documents.push(toSearchDocumentLite(row));
          existingCandidateIds.add(String(row.id));
        }
      }
    } catch {
      // If fetching extra rows fails, continue with existing lexical candidates
    }
  }

  const evaluated = documents.map((document) => {
    const exactSignals = computeExactSignals(document, normalized);
    const lexicalScore: LexicalScore = scoreDocument(document, normalized);
    const fuzzyConfidence = computeFuzzyConfidence(document, corrections);
    return { document, exactSignals, rankTierValue: rankTier(exactSignals), lexicalScore, fuzzyConfidence };
  });

  // Phase 2B: Product-safe catalog resolution (gated by VERITY_SEARCH_CATALOG_V1_ENABLED).
  // Confirmed media_asset_products mappings are promoted to Tier 0; unconfirmed
  // exact-SKU matches are demoted to preserve product_safe_false_positive_rate = 0.
  if (isSearchCatalogV1Enabled()) {
    const candidateSku = evaluated.find((item) => item.exactSignals.exactSku)?.document.sku;
    const tokenToResolve = candidateSku || normalized.normalizedWhitespace;
    let safeAssetIds: Set<string> | undefined = undefined;
    if (deps.resolveProductSafeAssetIds) {
      safeAssetIds = await deps.resolveProductSafeAssetIds(tokenToResolve);
    } else if (pool) {
      safeAssetIds = await resolveProductSafeAssetIds(pool, tokenToResolve);
    }
    if (safeAssetIds && safeAssetIds.size > 0) {
      for (const item of evaluated) {
        if (safeAssetIds.has(item.document.assetId)) {
          item.exactSignals.exactSku = true;
          item.rankTierValue = 0;
        } else if (item.exactSignals.exactSku) {
          item.exactSignals.exactSku = false;
          item.rankTierValue = rankTier(item.exactSignals);
        }
      }
    }
  }

  // Aggregated across the whole candidate pool (not just the returned
  // page) -- this is a signal about what the query matched, not per-row
  // ranking, so it must not depend on where pagination happens to cut.
  const detectedEntities: DetectedEntitySignals = {
    exactSku: evaluated.some((item) => item.exactSignals.exactSku),
    exactBrand: evaluated.some((item) => item.exactSignals.exactBrand),
    exactBrandModel: evaluated.some((item) => item.exactSignals.exactBrandModel),
    exactTitlePhrase: evaluated.some((item) => item.exactSignals.exactTitlePhrase),
  };

  const lexicalRanked: RankedChannelHit[] = evaluated
    .filter((item) => item.lexicalScore.total > 0)
    .sort((a, b) => b.lexicalScore.total - a.lexicalScore.total || (a.document.assetId < b.document.assetId ? -1 : 1))
    .map((item, index) => ({ assetId: item.document.assetId, rank: index + 1 }));

  const fusion = reciprocalRankFusion(lexicalRanked, semanticRanked, {
    rrfK: searchConfig.rrf_k,
    semanticWeight: searchConfig.semantic_weight,
    lexicalWeight: searchConfig.lexical_weight,
  });
  const fusionById = new Map(fusion.map((hit) => [hit.assetId, hit]));

  // Gap B mirror (Item: zero-evidence filter) -- a candidate only enters
  // final ranking if it carries >= 1 positive retrieval signal.
  const rerankCandidates: RerankCandidate[] = evaluated
    .filter((item) => {
      const hasPositiveEvidence =
        anyExact(item.exactSignals) ||
        item.lexicalScore.total > 0 ||
        item.fuzzyConfidence > 0 ||
        semanticRankById.get(item.document.assetId) != null;
      return hasPositiveEvidence;
    })
    .map((item) => {
      const fused = fusionById.get(item.document.assetId);
      return {
        assetId: item.document.assetId,
        rankTier: item.rankTierValue,
        exactSignals: item.exactSignals,
        lexicalScore: item.lexicalScore.total,
        fuzzyConfidence: item.fuzzyConfidence,
        correctionUsed: null,
        rrfScore: fused?.rrfScore ?? 0,
        lexicalRank: fused?.lexicalRank ?? null,
        semanticRank: fused?.semanticRank ?? null,
        entityOverlap: entityOverlapCount(item.exactSignals),
      } satisfies RerankCandidate;
    });

  const rerankedResults = rerank(rerankCandidates, {
    lexicalScore: searchConfig.rerank_lexical,
    fuzzyConfidence: searchConfig.rerank_fuzzy,
    rrfScore: searchConfig.rerank_rrf,
    entityOverlap: searchConfig.rerank_entity,
  });

  // Phase 2C: Maximal Marginal Relevance (MMR) visual diversification.
  // Gated by VERITY_SEARCH_MMR_V1_ENABLED. Reorders head candidates within RankTier
  // groups using pairwise cosine distance of 768-d SigLIP2 vectors.
  let finalResults = rerankedResults;
  if (isSearchMmrV1Enabled() && finalResults.length > 0) {
    let embeddingsMap = new Map<string, readonly number[]>();
    if (deps.fetchCandidateEmbeddings) {
      embeddingsMap = await deps.fetchCandidateEmbeddings(finalResults.map((r) => r.assetId));
    } else if (pool) {
      embeddingsMap = await fetchEmbeddingsFromDb(pool, finalResults.map((r) => r.assetId));
    }
    const mmrCandidates: MmrCandidate[] = finalResults.map((item) => ({
      assetId: item.assetId,
      rankTier: item.rankTier,
      relevance: item.combinedScore,
      embedding: embeddingsMap.get(item.assetId),
    }));
    const mmr = mmrDiversify(mmrCandidates, {
      lambda: searchConfig.mmr_lambda,
      poolSize: searchConfig.mmr_pool_size,
      outputSize: searchConfig.mmr_output_size,
    });
    if (mmr.applied) {
      const byId = new Map(finalResults.map((r) => [r.assetId, r]));
      finalResults = mmr.ordered.map((c) => byId.get(c.assetId)!);
    }
  }

  if (finalResults.length === 0) {
    return {
      data: [],
      total: 0,
      recoveryStageUsed: RecoveryStage.EXHAUSTED,
      semanticActive: false,
      detectedEntities: NO_DETECTED_ENTITIES,
    };
  }

  // Item 11: pagination happens strictly AFTER ranking & diversification.
  const total = finalResults.length;
  const offset = (params.page - 1) * params.pageSize;
  const pageIds = finalResults.slice(offset, offset + params.pageSize).map((result) => result.assetId);

  const rowById = new Map(candidateRows.map((row) => [String(row.id), row]));
  const pageRows = pageIds.map((id) => rowById.get(id)).filter((row): row is Row => Boolean(row));
  const urls = resolveMediaUrls(pageRows);
  const data = pageRows.map((row) => mapMediaAsset(row, urls));

  const resultScoresById: Record<string, number> = {};
  for (const item of finalResults) {
    resultScoresById[item.assetId] = item.combinedScore;
  }

  return {
    data,
    total,
    recoveryStageUsed: effectiveRecoveryStage,
    semanticActive: semanticHits.length > 0,
    semanticHitAssetIds: semanticHits.map((h) => h.assetId),
    resultScoresById,
    detectedEntities,
  };
}
