/**
 * Exact/entity channel -- TypeScript R0.1 serving-runtime counterpart to
 * backend/search_intelligence/exact_channel.py, carrying the SAME Gap-A
 * fix (PR #31 review 5109220215): Tier-0 exact SKU is a CONSERVATIVE,
 * catalog-agnostic DIRECT comparison between one candidate document's own
 * `sku` field and the raw/normalized query -- it never depends on a
 * frozen benchmark SKU vocabulary, so it works for any real catalog SKU.
 *
 * `RankTier` is a structural precedence, compared BEFORE any relevance
 * score -- never an arbitrary large-constant score hack. Two documents in
 * different tiers are never reordered by score; only documents within the
 * same tier are.
 */

import { boundedExactSpanMatch, normalizeForMatch, stripDiacritics, type NormalizedQuery } from './search-intelligence-vn';

export enum RankTier {
  TIER_0_EXACT_SKU = 0,
  TIER_1_EXACT_BRAND_MODEL = 1,
  TIER_2_EXACT_TITLE_PHRASE = 2,
  TIER_3_EXACT_BRAND = 3,
  TIER_4_RELEVANCE = 4,
}

export interface SearchDocumentLite {
  assetId: string;
  title: string;
  sku: string;
  brand: string;
  category: string;
  space: string;
  suggestedCaption: string;
  description?: string;
  keywords: readonly string[];
  usageCount: number;
  createdAt: string;
}

export interface ExactSignals {
  exactSku: boolean;
  exactBrandModel: boolean;
  exactTitlePhrase: boolean;
  exactBrand: boolean;
}

export function anyExact(signals: ExactSignals): boolean {
  return signals.exactSku || signals.exactBrandModel || signals.exactTitlePhrase || signals.exactBrand;
}

export function computeExactSignals(document: SearchDocumentLite, normalized: NormalizedQuery): ExactSignals {
  const docSkuNorm = normalizeForMatch(document.sku || '');
  const queryTextNorm = normalizeForMatch(normalized.accentedNormalized);
  // Gap A fix: direct, catalog-agnostic bounded-span comparison -- works
  // for ANY document.sku, not just a frozen vocabulary member.
  const exactSku = Boolean(docSkuNorm) && boundedExactSpanMatch(docSkuNorm, queryTextNorm);

  const docBrandFold = normalizeForMatch(stripDiacritics(document.brand || ''));
  const queryFoldNorm = normalizeForMatch(normalized.accentFolded);
  const exactBrand = Boolean(docBrandFold) && boundedExactSpanMatch(docBrandFold, queryFoldNorm);

  const exactBrandModel = exactSku && exactBrand;

  const haystackTitleAccented = normalizeForMatch(document.title || '');
  const haystackTitleFolded = normalizeForMatch(stripDiacritics(document.title || ''));
  const queryPhraseAccented = normalizeForMatch(normalized.accentedNormalized);
  const queryPhraseFolded = normalizeForMatch(normalized.accentFolded);
  const exactTitlePhrase =
    Boolean(queryPhraseAccented) &&
    (haystackTitleAccented.includes(queryPhraseAccented) || haystackTitleFolded.includes(queryPhraseFolded));

  return { exactSku, exactBrandModel, exactTitlePhrase, exactBrand };
}

export function rankTier(signals: ExactSignals): RankTier {
  if (signals.exactSku) return RankTier.TIER_0_EXACT_SKU;
  if (signals.exactBrandModel) return RankTier.TIER_1_EXACT_BRAND_MODEL;
  if (signals.exactTitlePhrase) return RankTier.TIER_2_EXACT_TITLE_PHRASE;
  if (signals.exactBrand) return RankTier.TIER_3_EXACT_BRAND;
  return RankTier.TIER_4_RELEVANCE;
}
