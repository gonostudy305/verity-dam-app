import { createHash } from 'node:crypto';

export const CREATIVE_PAYLOAD_HASH_VERSION = 'jcs-sha256-v1';

export type CreativeArticleSection = {
  id: string;
  heading: string;
  body: string;
  product_id?: string | null;
};

export type CreativeArticlePayload = {
  external_source: string;
  external_article_id: string;
  external_revision: string;
  supersedes_revision?: string | null;
  brand_version_id: string;
  channel_version_id: string;
  budget_period_id?: string | null;
  title: string;
  body?: string;
  product_id?: string | null;
  thumbnail_template_version_id: string;
  section_template_version_id: string;
  sections?: CreativeArticleSection[];
  max_section_images?: number;
  source_policy?: Record<string, unknown>;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * V1 routing is intentionally server-owned.  A caller may describe content,
 * but cannot turn an internal article job into an unbounded AI-first job.
 */
export const CREATIVE_V1_SOURCE_POLICY = Object.freeze({
  order: ['library', 'ai'] as const,
  max_candidates: 2,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Creative payload cannot contain non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Creative payload contains a non-JSON value.');
}

function compactRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item as JsonValue;
  }
  return out;
}

/** Server-owned normalized contract. Only fields with semantic meaning enter
 * the idempotency hash; HTTP headers, trace metadata and undefined values do not. */
export function normalizeCreativeArticlePayload(input: CreativeArticlePayload) {
  const maxSectionImages = Math.min(Math.max(Math.trunc(input.max_section_images ?? 3), 0), 3);
  const sections = (input.sections || []).map((section) => compactRecord({
    id: section.id.trim(),
    heading: section.heading.trim(),
    body: section.body,
    product_id: section.product_id || undefined,
  }));
  return compactRecord({
    external_source: input.external_source.trim(),
    external_article_id: input.external_article_id.trim(),
    external_revision: input.external_revision.trim(),
    supersedes_revision: input.supersedes_revision?.trim() || undefined,
    brand_version_id: input.brand_version_id,
    channel_version_id: input.channel_version_id,
    budget_period_id: input.budget_period_id || undefined,
    title: input.title.trim(),
    body: input.body || '',
    product_id: input.product_id || undefined,
    thumbnail_template_version_id: input.thumbnail_template_version_id,
    section_template_version_id: input.section_template_version_id,
    max_section_images: maxSectionImages,
    source_policy: compactRecord(CREATIVE_V1_SOURCE_POLICY),
    sections,
  });
}

export function hashCreativePayload(normalizedPayload: unknown): string {
  return createHash('sha256').update(canonicalJson(normalizedPayload), 'utf8').digest('hex');
}

export type PlannedCreativeSlot = {
  slotKey: string;
  slotKind: 'thumbnail' | 'section';
  templateVersionId: string;
  targetProductId: string | null;
  contentSnapshot: Record<string, unknown>;
};

/** Deterministic V1 placement: content is never sent to a text model. */
export function planCreativeSlots(payload: ReturnType<typeof normalizeCreativeArticlePayload>): PlannedCreativeSlot[] {
  const sourcePolicy = payload.source_policy as Record<string, unknown>;
  const slots: PlannedCreativeSlot[] = [{
    slotKey: 'thumbnail',
    slotKind: 'thumbnail',
    templateVersionId: String(payload.thumbnail_template_version_id),
    targetProductId: typeof payload.product_id === 'string' ? payload.product_id : null,
    contentSnapshot: { title: payload.title, body: payload.body, source_policy: sourcePolicy },
  }];

  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const maximum = Number(payload.max_section_images || 0);
  const ranked = sections
    .map((section, index) => {
      const item = section as Record<string, unknown>;
      const heading = String(item.heading || '');
      const body = String(item.body || '');
      const productBonus = typeof item.product_id === 'string' && item.product_id ? 10_000 : 0;
      // Stable tie-breaking preserves source section order.
      return { item, index, score: productBonus + Math.min(body.length, 8_000) + Math.min(heading.length, 400) * 10 };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maximum)
    .sort((a, b) => a.index - b.index);

  for (const { item, index } of ranked) {
    const sectionId = String(item.id || `section-${index + 1}`);
    slots.push({
      slotKey: `section:${sectionId}`,
      slotKind: 'section',
      templateVersionId: String(payload.section_template_version_id),
      targetProductId: typeof item.product_id === 'string' ? item.product_id : null,
      contentSnapshot: { section_id: sectionId, heading: String(item.heading || ''), body: String(item.body || ''), source_policy: sourcePolicy },
    });
  }
  return slots;
}
