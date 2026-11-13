/**
 * Unified Internal Media Search Endpoint (Phase 3B / Issue #51).
 *
 * Single SSOT internal structured search route proxying the canonical Next.js
 * search-intelligence engine to internal callers (MCP gateway, agents, workers).
 *
 * Security & Auth:
 * - Requires `x-internal-service-key` matching process.env.VERITY_INTERNAL_SERVICE_KEY (fails closed).
 * - Requires `x-actor-user-id` carrying the authenticated actor identity.
 * - Resolves actor's real role from PostgreSQL (public."user"); NEVER trusts caller-asserted roles.
 * - Preserves viewer/contributor/reviewer/admin permission boundaries.
 * - Bounded concurrency (rate limit) to protect Next.js runtime.
 *
 * Product-Safe & Zero Fabrication:
 * - Only queries and returns confirmed relations from public.media_asset_products (review_state = 'confirmed').
 * - Zero synthesis from legacy unverified attributes.
 * - Fails closed on database exceptions.
 */

import { NextRequest, NextResponse } from 'next/server';

import { parseMediaListParams } from '@/lib/media-api';
import { errorResponse, ApiError } from '@/lib/server/http';
import { listNativeLibraryMedia } from '@/lib/server/native-media';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { getRole, type VerityRole } from '@/lib/auth';
import { isSearchIntelligenceV1Enabled } from '@/lib/server/search-intelligence-flag';
import { isIntelligenceEligible } from '@/lib/server/search-intelligence-route-policy';
import {
  listNativeLibraryMediaIntelligent,
  parseIntelligenceRawQuery,
} from '@/lib/server/native-search-intelligence';
import { composeAgentDescription } from '@/lib/server/agent-view';
import { formatMediaSearchResultUrls } from '@/lib/server/media-search-result-urls';
import type { MediaAsset } from '@/types/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Bounded concurrency rate limiter (max 10 concurrent requests to protect Next.js)
const MAX_CONCURRENT_REQUESTS = 10;
let activeRequests = 0;

interface InternalActorContext {
  id: string;
  email: string;
  role: VerityRole;
}

interface ConfirmedProductRow {
  media_asset_id: string;
  product_id: string;
  code: string;
  display_name: string | null;
  brand: string | null;
  category: string | null;
  role: string | null;
  confidence: number | null;
}

async function authenticateInternalRequest(request: NextRequest): Promise<InternalActorContext> {
  const serviceKey = request.headers.get('x-internal-service-key') || '';
  const expectedKey = process.env.VERITY_INTERNAL_SERVICE_KEY?.trim();

  // Fail closed: must be explicitly configured in environment
  if (!expectedKey) {
    throw new ApiError(500, 'SERVICE_KEY_UNCONFIGURED', 'VERITY_INTERNAL_SERVICE_KEY must be configured in environment');
  }

  if (!serviceKey || serviceKey !== expectedKey) {
    throw new ApiError(401, 'UNAUTHORIZED_INTERNAL_SERVICE', 'Invalid or missing x-internal-service-key');
  }

  const actorUserId = request.headers.get('x-actor-user-id') || '';
  if (!actorUserId) {
    throw new ApiError(400, 'ACTOR_USER_ID_REQUIRED', 'Missing x-actor-user-id header');
  }

  const pool = requireNativeDatabase();
  const res = await pool.query<{ id: string; email: string; role: string }>(
    'SELECT id, email, role FROM public."user" WHERE id = $1 LIMIT 1',
    [actorUserId]
  );

  if (!res.rows.length) {
    throw new ApiError(403, 'ACTOR_NOT_FOUND', `Actor user ${actorUserId} not found in database`);
  }

  const user = res.rows[0];
  const role = getRole(user.role) || 'viewer';

  return {
    id: user.id,
    email: user.email,
    role,
  };
}

async function fetchConfirmedProductLinks(assetIds: string[]): Promise<Map<string, ConfirmedProductRow[]>> {
  if (assetIds.length === 0) return new Map();
  const pool = requireNativeDatabase();
  try {
    const res = await pool.query<ConfirmedProductRow>(
      `SELECT mp.media_asset_id, mp.product_id, mp.role, mp.confidence,
              p.code, p.display_name, p.brand, p.category
       FROM public.media_asset_products mp
       JOIN public.verity_products p ON p.id = mp.product_id
       WHERE mp.media_asset_id = ANY($1::uuid[])
         AND mp.review_state = 'confirmed'
       ORDER BY (mp.role = 'primary') DESC, mp.confidence DESC NULLS LAST`,
      [assetIds]
    );
    const map = new Map<string, ConfirmedProductRow[]>();
    for (const row of res.rows) {
      const list = map.get(row.media_asset_id) || [];
      list.push(row);
      map.set(row.media_asset_id, list);
    }
    return map;
  } catch (err) {
    // Fail-closed on DB error: return empty map
    console.error('[internal-media-search] Failed to fetch confirmed product links (failing closed):', err);
    return new Map();
  }
}

function formatResultItems(
  assets: MediaAsset[],
  rawQuery: string,
  searchMeta: { used: boolean; detected_entities?: Record<string, boolean>; semantic_active?: boolean },
  confirmedLinksMap: Map<string, ConfirmedProductRow[]>,
  semanticHitAssetIds?: Set<string>,
  resultScoresById?: Record<string, number>
) {
  const queryUpper = rawQuery.toUpperCase();

  return assets.map((a, idx) => {
    const confirmedLinks = confirmedLinksMap.get(a.id) || [];

    // Zero fabrication: canonical SKU matches come ONLY from verified confirmed relations in media_asset_products
    const canonicalSkuMatches = confirmedLinks.map((p) => ({
      product_id: p.product_id,
      code: p.code,
      display_name: p.display_name || p.code,
      brand: p.brand || null,
      category: p.category || null,
      role: p.role || null,
      confidence: p.confidence ?? 1.0,
    }));

    // Check if any confirmed link matches the search query tokens
    const matchingLink = canonicalSkuMatches.find(
      (p) => p.code && queryUpper.includes(p.code.toUpperCase())
    );
    const hasExactSkuMatch = Boolean(matchingLink);

    const matchReasons: string[] = [];
    if (hasExactSkuMatch) {
      matchReasons.push('exact_sku_match');
    }
    if (searchMeta.detected_entities?.exact_brand_model || searchMeta.detected_entities?.exact_brand) {
      matchReasons.push('brand_model_match');
    }
    // Truthful attribution: only tag semantic_match if this specific asset was matched by semantic channel
    if (semanticHitAssetIds?.has(a.id)) {
      matchReasons.push('semantic_match');
    }
    if (matchReasons.length === 0) {
      matchReasons.push('lexical_match');
    }

    // Product safety evaluation:
    // If the query targeted a specific SKU/product: safe ONLY if the asset carries a CONFIRMED match for it.
    // If query did not target a specific SKU: safe for general/scene use.
    const isTargetingSku = Boolean(searchMeta.detected_entities?.exact_sku);
    const safeForExactProductUse = !isTargetingSku || hasExactSkuMatch;

    const truthfulScore = resultScoresById && resultScoresById[a.id] !== undefined
      ? Number(resultScoresById[a.id].toFixed(4))
      : Number((1.0 / (idx + 1)).toFixed(4));
    const urls = formatMediaSearchResultUrls(a);

    return {
      asset_id: a.id,
      title: a.title,
      description: composeAgentDescription(a) || a.description || null,
      thumbnail_url: urls.thumbnail_url,
      // Preserve this legacy field for existing clients, but make it safe as
      // the default publishing URL whenever a canonical rendition exists.
      file_url: urls.file_url,
      cdn_url: urls.cdn_url,
      width: urls.width,
      height: urls.height,
      permission: a.permission,
      status: a.status,
      has_open_report: Boolean(a.has_open_report),
      needs_post_production: Boolean(a.needs_post_production),
      canonical_sku_matches: canonicalSkuMatches,
      match_reasons: matchReasons,
      product_safety: {
        safe_for_exact_product_use: safeForExactProductUse,
        verified_sku: matchingLink ? matchingLink.code : null,
        flag_details: a.ai_flags || {},
      },
      score: truthfulScore,
    };
  });
}

async function handleSearch(request: NextRequest, bodyOrParams: Record<string, any>) {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Internal media-search concurrency limit reached');
  }

  activeRequests++;
  try {
    const actor = await authenticateInternalRequest(request);

    // Map input fields into canonical URLSearchParams for parseMediaListParams
    const rawQuery = (
      typeof bodyOrParams.query === 'string'
        ? bodyOrParams.query
        : typeof bodyOrParams.q === 'string'
          ? bodyOrParams.q
          : ''
    ).trim();

    const searchParams = new URLSearchParams();
    searchParams.set('q', rawQuery);

    // Pagination mapping: limit -> page_size, offset -> page
    const rawLimit = Number(bodyOrParams.limit ?? bodyOrParams.page_size) || 20;
    const pageSize = Math.min(Math.max(rawLimit, 1), 100);
    const rawOffset = Number(bodyOrParams.offset) || 0;
    const rawPage = Number(bodyOrParams.page);
    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : Math.floor(rawOffset / pageSize) + 1;

    searchParams.set('page_size', String(pageSize));
    searchParams.set('page', String(page));

    // Filters forwarding
    for (const filterKey of ['category', 'space', 'status', 'permission', 'source', 'media_type', 'sort']) {
      const val = bodyOrParams[filterKey];
      if (val !== undefined && val !== null) {
        if (Array.isArray(val)) {
          for (const item of val) {
            searchParams.append(filterKey, String(item));
          }
        } else {
          searchParams.set(filterKey, String(val));
        }
      }
    }

    const params = parseMediaListParams(searchParams);
    const includeDeletedRequested = ['1', 'true'].includes(String(bodyOrParams.include_deleted || '').toLowerCase());
    const includeDeleted = includeDeletedRequested && actor.role === 'admin';
    const canSeeInternal = actor.role !== 'viewer';

    const includeReportedRequested = ['1', 'true'].includes(String(bodyOrParams.include_reported || '').toLowerCase());
    if (includeReportedRequested && actor.role !== 'reviewer' && actor.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only reviewer or admin accounts may include reported assets');
    }
    const excludeReported = !includeReportedRequested;

    const includeUnfinishedRequested = ['1', 'true'].includes(String(bodyOrParams.include_unfinished || '').toLowerCase());
    if (includeUnfinishedRequested && actor.role !== 'reviewer' && actor.role !== 'admin') {
      throw new ApiError(403, 'FORBIDDEN', 'Only reviewer or admin accounts may include unfinished (needs-post-production) assets');
    }
    const excludeUnfinished = !includeUnfinishedRequested;

    const listOptions = { includeDeleted, deletedOnly: false, canSeeInternal, excludeReported, excludeUnfinished };

    const intelligenceRawQuery = parseIntelligenceRawQuery(searchParams);

    const requestedMode = typeof bodyOrParams.mode === 'string' ? bodyOrParams.mode.toLowerCase() : null;
    const flagEnabled = requestedMode === 'baseline'
      ? false
      : (requestedMode === 'intelligent' ? true : isSearchIntelligenceV1Enabled());

    const intelligenceEligible = isIntelligenceEligible({
      flagEnabled,
      query: params.query,
      sort: params.sort,
      includeDeleted,
      deletedOnly: false,
    });

    let searchMeta: {
      used: boolean;
      recovery_stage?: string;
      semantic_active?: boolean;
      detected_entities?: {
        exact_sku: boolean;
        exact_brand: boolean;
        exact_brand_model: boolean;
        exact_title_phrase: boolean;
      };
      actor_role: string;
    } = {
      used: false,
      actor_role: actor.role,
    };

    let rawData: MediaAsset[] = [];
    let totalCount = 0;
    let semanticHitAssetIds: Set<string> | undefined = undefined;
    let resultScoresById: Record<string, number> | undefined = undefined;

    if (intelligenceEligible) {
      try {
        const intelligent = await listNativeLibraryMediaIntelligent(params, intelligenceRawQuery, listOptions);
        rawData = intelligent.data;
        totalCount = intelligent.total;
        if (intelligent.semanticHitAssetIds) {
          semanticHitAssetIds = new Set(intelligent.semanticHitAssetIds);
        }
        resultScoresById = intelligent.resultScoresById;
        searchMeta = {
          used: true,
          recovery_stage: intelligent.recoveryStageUsed,
          semantic_active: intelligent.semanticActive,
          detected_entities: {
            exact_sku: intelligent.detectedEntities.exactSku,
            exact_brand: intelligent.detectedEntities.exactBrand,
            exact_brand_model: intelligent.detectedEntities.exactBrandModel,
            exact_title_phrase: intelligent.detectedEntities.exactTitlePhrase,
          },
          actor_role: actor.role,
        };
      } catch {
        const baseline = await listNativeLibraryMedia(params, listOptions);
        rawData = baseline.data;
        totalCount = baseline.total;
      }
    } else {
      const baseline = await listNativeLibraryMedia(params, listOptions);
      rawData = baseline.data;
      totalCount = baseline.total;
    }

    // Fetch canonical confirmed product associations for the returned batch
    const assetIds = rawData.map((a) => a.id).filter(Boolean);
    const confirmedLinksMap = await fetchConfirmedProductLinks(assetIds);

    const formattedResults = formatResultItems(
      rawData,
      intelligenceRawQuery,
      searchMeta,
      confirmedLinksMap,
      semanticHitAssetIds,
      resultScoresById
    );

    return NextResponse.json({
      query: intelligenceRawQuery,
      total: totalCount,
      returned: formattedResults.length,
      results: formattedResults,
      search_meta: searchMeta,
    });
  } finally {
    activeRequests--;
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    return await handleSearch(request, body);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const paramsObj: Record<string, string> = {};
    request.nextUrl.searchParams.forEach((value, key) => {
      paramsObj[key] = value;
    });
    return await handleSearch(request, paramsObj);
  } catch (error) {
    return errorResponse(error);
  }
}
