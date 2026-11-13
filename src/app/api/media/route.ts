import { NextRequest, NextResponse } from 'next/server';

import { isMediaUrlOrPathCandidate, parseMediaListParams } from '@/lib/media-api';
import { errorResponse } from '@/lib/server/http';
import { listNativeLibraryMedia, resolveNativeMediaAsset } from '@/lib/server/native-media';
import { requireNativeAdmin, requireNativeMember } from '@/lib/server/native-auth';
import { isSearchIntelligenceV1Enabled, isSearchShadowV1Enabled } from '@/lib/server/search-intelligence-flag';
import { isUserInCanary, getSearchCanaryPercent } from '@/lib/server/search-intelligence-canary';
import { runSearchIntelligenceGateway } from '@/lib/server/search-intelligence-gateway';
import { isIntelligenceEligible } from '@/lib/server/search-intelligence-route-policy';
import { IntelligenceFallbackError, listNativeLibraryMediaIntelligent, parseIntelligenceRawQuery } from '@/lib/server/native-search-intelligence';
import { runSearchShadow } from '@/lib/server/search-intelligence-shadow';
import { nullSemanticRetriever } from '@/lib/server/search-intelligence-semantic';

export const dynamic = 'force-dynamic';

interface SearchMeta {
  used: boolean;
  recovery_stage?: string;
  semantic_active?: boolean;
  detected_entities?: {
    exact_sku: boolean;
    exact_brand: boolean;
    exact_brand_model: boolean;
    exact_title_phrase: boolean;
  };
}

export async function GET(request: NextRequest) {
  try {
    const params = parseMediaListParams(request.nextUrl.searchParams);
    const includeDeleted = ['1', 'true'].includes((request.nextUrl.searchParams.get('include_deleted') || '').toLowerCase());
    const deletedOnly = ['1', 'true'].includes((request.nextUrl.searchParams.get('deleted_only') || '').toLowerCase());
    const context = includeDeleted || deletedOnly ? await requireNativeAdmin() : await requireNativeMember();
    const listOptions = { includeDeleted, deletedOnly, canSeeInternal: context.role !== 'viewer' };

    // Fast-path: When search query is an image URL, CDN key, or storage path,
    // resolve directly via indexed reverse lookup to bypass NLP/FTS limitations.
    const rawTarget = (request.nextUrl.searchParams.get('q') || '').trim();
    if (isMediaUrlOrPathCandidate(rawTarget)) {
      const canSeePending = context.role === 'reviewer' || context.role === 'admin';
      const resolvedAsset = await resolveNativeMediaAsset(
        rawTarget,
        canSeePending,
        includeDeleted,
        listOptions.canSeeInternal
      );
      if (resolvedAsset) {
        return NextResponse.json({
          data: [resolvedAsset],
          total: 1,
          mode: 'native',
          search_meta: {
            used: true,
            recovery_stage: 'URL_EXACT_RESOLVED',
          },
        });
      }
    }

    // Items 12/13: the intelligence path is only ever CONSTRUCTED (let
    // alone executed) when the flag is true AND the request is eligible
    // (non-empty query, default "newest" sort, not the deleted/pending
    // admin views). This is what gives "flag false -> zero extra
    // intelligence DB queries" for free -- there is nothing for the
    // gateway to call in that case.
    const rawQuery = parseIntelligenceRawQuery(request.nextUrl.searchParams);
    const inCanary = isUserInCanary(context.user.id, getSearchCanaryPercent());
    const intelligenceEligible = isIntelligenceEligible({
      flagEnabled: isSearchIntelligenceV1Enabled() || inCanary,
      query: params.query,
      sort: params.sort,
      includeDeleted,
      deletedOnly,
    });

    const shadowEligible =
      !intelligenceEligible &&
      isIntelligenceEligible({
        flagEnabled: isSearchShadowV1Enabled(),
        query: params.query,
        sort: params.sort,
        includeDeleted,
        deletedOnly,
      });

    // Populated only when the intelligence path actually completes -- never
    // when it is merely eligible/attempted. If it throws (caught below) or
    // was never eligible, this stays {used:false} and the FE must not claim
    // recovery/semantic activity that never happened.
    let searchMeta: SearchMeta = { used: false };

    const result = await runSearchIntelligenceGateway({
      baseline: () => listNativeLibraryMedia(params, listOptions),
      intelligence: intelligenceEligible
        ? async () => {
            try {
              const intelligent = await listNativeLibraryMediaIntelligent(params, rawQuery, listOptions);
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
              };
              return { data: intelligent.data, total: intelligent.total };
            } catch (error) {
              // Item 14: structured, PII/secret-free diagnostic logging.
              // Never logs the raw query text/tokens -- only its length
              // and, when available, the internal fallback reason.
              const reason = error instanceof IntelligenceFallbackError ? error.reason : 'INTELLIGENCE_PATH_ERROR';
              console.error('[search-intelligence] falling back to BASELINE_L0', {
                reason,
                queryLength: rawQuery.length,
              });
              throw error;
            }
          }
        : undefined,
      shadow: shadowEligible
        ? (baselineResult) => {
            void runSearchShadow({
              query: rawQuery,
              baselineData: baselineResult.data,
              runIntelligence: ({ enableSemanticOnExhausted, semanticEligible }) =>
                listNativeLibraryMediaIntelligent(params, rawQuery, listOptions, {
                  enableSemanticOnExhausted,
                  ...(semanticEligible ? {} : { semanticRetriever: nullSemanticRetriever }),
                }),
            });
          }
        : undefined,
    });

    return NextResponse.json({ ...result, search_meta: searchMeta });
  } catch (error) {
    return errorResponse(error);
  }
}
