/**
 * Field-weighted, explainable lexical scorer -- TypeScript counterpart to
 * backend/search_intelligence/lexical_scorer.py. Every score exposes its
 * full component breakdown; `CANDIDATE_WEIGHTS_ONLY` is explicitly NOT
 * production truth -- placeholder weights, same disclaimer as the Python
 * reference (real weight tuning is future work, gated on Suite C human
 * labels + a future LTR checkpoint, never invented here).
 */

import { normalizeForMatch, stripDiacritics, tokenize, type NormalizedQuery } from './search-intelligence-vn';
import type { SearchDocumentLite } from './search-intelligence-exact';

const SCORED_FIELDS = ['sku', 'title', 'brand', 'category', 'space', 'keywords', 'caption', 'description'] as const;
type ScoredField = (typeof SCORED_FIELDS)[number];

export const CANDIDATE_WEIGHTS_ONLY: Record<string, number> = {
  sku_exact_phrase: 5.0,
  sku_token_coverage: 3.0,
  sku_prefix_match: 2.0,
  title_exact_phrase: 3.0,
  title_all_token_match: 2.0,
  title_token_coverage: 1.5,
  title_prefix_match: 1.0,
  brand_exact_phrase: 2.5,
  brand_token_coverage: 1.0,
  brand_prefix_match: 0.5,
  category_exact_phrase: 2.0,
  category_token_coverage: 1.0,
  category_prefix_match: 0.5,
  space_exact_phrase: 1.5,
  space_token_coverage: 0.75,
  space_prefix_match: 0.25,
  keywords_token_coverage: 1.0,
  keywords_exact_phrase: 1.5,
  caption_token_coverage: 0.5,
  caption_exact_phrase: 0.75,
  description_token_coverage: 0.5,
  description_exact_phrase: 0.75,
};

export const ACCENTED_MATCH_BONUS = 0.1;

interface FieldFeatures {
  exactPhrase: boolean;
  allTokenMatch: boolean;
  tokenCoverage: number;
  prefixMatch: boolean;
  accentedMatch: boolean;
}

function fieldFeatures(fieldText: string, normalized: NormalizedQuery): FieldFeatures {
  const fieldAccented = normalizeForMatch(fieldText);
  const fieldFolded = normalizeForMatch(stripDiacritics(fieldText));
  const queryAccented = normalizeForMatch(normalized.accentedNormalized);
  const queryFolded = normalizeForMatch(normalized.accentFolded);

  if (!fieldAccented || !queryAccented) {
    return { exactPhrase: false, allTokenMatch: false, tokenCoverage: 0, prefixMatch: false, accentedMatch: false };
  }

  const exactPhraseAccented = fieldAccented.includes(queryAccented);
  const exactPhraseFolded = fieldFolded.includes(queryFolded);
  const exactPhrase = exactPhraseAccented || exactPhraseFolded;

  const fieldTokensFolded = new Set(tokenize(fieldFolded));
  const queryTokens = normalized.foldedTokens;
  let tokenCoverage = 0;
  let allTokenMatch = false;
  if (queryTokens.length > 0) {
    const matched = queryTokens.filter((token) => fieldTokensFolded.has(token)).length;
    tokenCoverage = matched / queryTokens.length;
    allTokenMatch = matched === queryTokens.length;
  }

  const prefixMatch = fieldAccented.startsWith(queryAccented) || fieldFolded.startsWith(queryFolded);

  return { exactPhrase, allTokenMatch, tokenCoverage, prefixMatch, accentedMatch: exactPhraseAccented };
}

function fieldText(document: SearchDocumentLite, field: ScoredField): string {
  if (field === 'keywords') return document.keywords.join(' ');
  if (field === 'caption') return document.suggestedCaption;
  if (field === 'description') return document.description ?? '';
  return document[field] ?? '';
}

export interface LexicalScore {
  total: number;
  breakdown: Record<string, number>;
}

export function scoreDocument(document: SearchDocumentLite, normalized: NormalizedQuery): LexicalScore {
  const breakdown: Record<string, number> = {};
  let total = 0;

  for (const field of SCORED_FIELDS) {
    const text = fieldText(document, field);
    if (!text) continue;
    const features = fieldFeatures(text, normalized);

    if (features.exactPhrase) {
      const weight = CANDIDATE_WEIGHTS_ONLY[`${field}_exact_phrase`] ?? 0;
      if (weight) {
        breakdown[`${field}_exact_phrase`] = weight;
        total += weight;
      }
    }
    if (features.allTokenMatch && `${field}_all_token_match` in CANDIDATE_WEIGHTS_ONLY) {
      const weight = CANDIDATE_WEIGHTS_ONLY[`${field}_all_token_match`];
      breakdown[`${field}_all_token_match`] = weight;
      total += weight;
    }
    if (features.tokenCoverage > 0) {
      const weight = (CANDIDATE_WEIGHTS_ONLY[`${field}_token_coverage`] ?? 0) * features.tokenCoverage;
      if (weight) {
        breakdown[`${field}_token_coverage`] = Math.round(weight * 1e6) / 1e6;
        total += weight;
      }
    }
    if (features.prefixMatch) {
      const weight = CANDIDATE_WEIGHTS_ONLY[`${field}_prefix_match`] ?? 0;
      if (weight) {
        breakdown[`${field}_prefix_match`] = weight;
        total += weight;
      }
    }
    if (features.accentedMatch) {
      breakdown[`${field}_accented_bonus`] = ACCENTED_MATCH_BONUS;
      total += ACCENTED_MATCH_BONUS;
    }
  }

  return { total: Math.round(total * 1e6) / 1e6, breakdown };
}
