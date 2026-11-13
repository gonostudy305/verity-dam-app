import { requireNativeDatabase } from './native-db';
import type { SynonymItem } from './synonym-types';

let cache: { at: number; items: SynonymItem[] } | null = null;
const TTL = 60_000;

export async function getNativeSynonymsConfig(): Promise<SynonymItem[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.items;
  const result = await requireNativeDatabase().query<{ items: unknown }>(
    `select items from public.verity_synonyms_config where config_key = 'default' limit 1`
  );
  const items = Array.isArray(result.rows[0]?.items) ? result.rows[0].items as SynonymItem[] : [];
  cache = { at: Date.now(), items };
  return items;
}

export async function saveNativeSynonymsConfig(items: SynonymItem[], updatedBy: string) {
  await requireNativeDatabase().query(
    `insert into public.verity_synonyms_config(config_key, items, updated_by, updated_at)
     values ('default', $1::jsonb, $2, now())
     on conflict (config_key) do update set items = excluded.items, updated_by = excluded.updated_by, updated_at = now()`,
    [JSON.stringify(items), updatedBy]
  );
  cache = { at: Date.now(), items };
  return items;
}

export function bustNativeSynonymsCache() {
  cache = null;
}

/**
 * Vietnamese search-INTENT meta words: a user types these to say "I want a
 * PHOTO of X", but they never appear IN the indexed content itself (a
 * caption/title/keyword describes the subject, it never calls itself
 * "ảnh"/"hình"). Left in the query, they poison the literal ILIKE substring
 * built by buildIlikeTermCondition -- "ảnh robot" never matches any row
 * because no field contains the literal substring "ảnh robot", even though
 * "robot" alone matches four. See docs/brainstorm-2026-09-07... root-cause note.
 *
 * Deliberately a SMALL, explicit list -- not a general Vietnamese stopword
 * list. Broader function-word removal is a bigger, separate concern already
 * handled correctly (via proper tokenization) by the flag-gated
 * search_intelligence engine; this is a minimal, low-risk fix scoped to the
 * one reported failure class in the BASELINE_L0 path.
 */
const SEARCH_INTENT_STOPWORDS = new Set(['ảnh', 'hình', 'tấm', 'bức']);

/**
 * Strip standalone search-intent stopwords (see above) from a raw query
 * before it becomes a literal ILIKE substring. Whitespace-only tokenization
 * (never breaks internal hyphens, so SKU-like tokens are untouched) and
 * case-insensitive via the same `vi-VN` locale-lowercasing convention used
 * elsewhere in this codebase (demo-media.ts's matchesQuery).
 *
 * Never returns an empty string when the input wasn't empty: if every token
 * is a stopword (e.g. the query was just "ảnh"), the original query is
 * returned unchanged rather than turned into an unconstrained "match
 * everything" filter -- that would be a behavior change beyond this bugfix's
 * scope (today "ảnh" alone already yields 0 results; this keeps it that way).
 */
export function stripSearchStopwords(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  if (!trimmed) return trimmed;
  const tokens = trimmed.split(/\s+/);
  const kept = tokens.filter((token) => !SEARCH_INTENT_STOPWORDS.has(token.toLocaleLowerCase('vi-VN')));
  return kept.length > 0 ? kept.join(' ') : trimmed;
}

export function expandSearchTerms(rawQuery: string, items: SynonymItem[]): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const terms = new Set([rawQuery.trim()]);
  for (const rule of items) {
    const from = rule.from.trim().toLowerCase();
    if (query === from || query.includes(from) || from.includes(query)) {
      rule.to.split(',').map((value) => value.trim()).filter(Boolean).forEach((value) => terms.add(value));
    }
  }
  return [...terms];
}
