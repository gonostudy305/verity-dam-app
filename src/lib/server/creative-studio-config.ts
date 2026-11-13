import type { PoolClient } from "pg";

import { hashCreativePayload } from "@/lib/creative";
import {
  parseCreativeProviderConfig,
  parsePreservePixelsLayout,
} from "@/lib/creative-generation";
import { isUuid } from "@/lib/media-api";
import { getSharedCreativeConfig } from "./creative-config";
import { ApiError, notFound } from "./http";
import { requireNativeDatabase } from "./native-db";

type JsonRecord = Record<string, unknown>;
type ResourceKind =
  | "brand-version"
  | "channel-version"
  | "template-version"
  | "budget-period"
  | "bootstrap";

const MAX_CONFIG_BYTES = 32_000;

function object(value: unknown, field: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} phải là object JSON.`,
    );
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_CONFIG_BYTES) {
    throw new ApiError(
      400,
      "CREATIVE_CONFIGURATION_TOO_LARGE",
      `${field} vượt giới hạn cấu hình.`,
    );
  }
  return value as JsonRecord;
}

function text(value: unknown, field: string, limit = 240): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} là bắt buộc.`,
    );
  }
  const normalized = value.trim();
  if (normalized.length > limit) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} quá dài.`,
    );
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  limit = 240,
): string | null {
  if (value == null || value === "") return null;
  return text(value, field, limit);
}

function slug(value: unknown, field: string): string {
  const normalized = text(value, field, 63).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_SLUG",
      `${field} chỉ gồm chữ thường, số và dấu gạch ngang.`,
    );
  }
  return normalized;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} không hợp lệ.`,
    );
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  return uuid(value, field);
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} không hợp lệ.`,
    );
  }
  return parsed;
}

function isoDate(value: unknown, field: string): string {
  const normalized = text(value, field, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
    Number.isNaN(new Date(`${normalized}T00:00:00.000Z`).getTime())
  ) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      `${field} phải theo YYYY-MM-DD.`,
    );
  }
  return normalized;
}

export function validateCreativeTemplateConfig(value: unknown): JsonRecord {
  const config = object(value, "config");
  if (typeof config.prompt !== "string" || !config.prompt.trim()) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_TEMPLATE",
      "Template cần prompt không rỗng.",
    );
  }
  try {
    parseCreativeProviderConfig(config);
    const fidelityMode = config.fidelity_mode;
    if (
      fidelityMode != null &&
      fidelityMode !== "reference_generate" &&
      fidelityMode !== "preserve_pixels"
    ) {
      throw new Error("fidelity_mode is invalid");
    }
    if (fidelityMode === "preserve_pixels") parsePreservePixelsLayout(config);
  } catch (error) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_TEMPLATE",
      error instanceof Error ? error.message : "Template không hợp lệ.",
    );
  }
  return config;
}

async function nextVersion(
  client: PoolClient,
  table:
    | "creative_brand_versions"
    | "creative_channel_versions"
    | "creative_template_versions",
  foreignKey: string,
  parentId: string,
): Promise<number> {
  const result = await client.query<{ version: number }>(
    `select coalesce(max(version), 0)::int as version from public.${table} where ${foreignKey} = $1`,
    [parentId],
  );
  return (result.rows[0]?.version || 0) + 1;
}

async function lockProfile(
  client: PoolClient,
  table:
    | "creative_brand_profiles"
    | "creative_channel_profiles"
    | "creative_templates",
  id: string,
  label: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select id from public.${table} where id = $1 and status = 'active' for update`,
    [id],
  );
  if (!result.rows[0])
    throw notFound(`${label} không tồn tại hoặc đã retired.`);
}

async function createBrandVersion(
  client: PoolClient,
  value: JsonRecord,
  actorId: string,
): Promise<{ profileId: string; versionId: string; version: number }> {
  const config = object(value.config, "config");
  const profileId = optionalUuid(value.profile_id, "profile_id");
  let parentId = profileId;
  if (parentId) {
    await lockProfile(
      client,
      "creative_brand_profiles",
      parentId,
      "Brand profile",
    );
  } else {
    const requestedSlug = slug(value.slug, "slug");
    const existing = await client.query<{ id: string }>(
      `select id from public.creative_brand_profiles where slug = $1`,
      [requestedSlug],
    );
    if (existing.rows[0])
      throw new ApiError(
        409,
        "CREATIVE_PROFILE_SLUG_EXISTS",
        "Brand slug đã tồn tại; hãy tạo version mới bằng profile_id.",
      );
    const inserted = await client.query<{ id: string }>(
      `insert into public.creative_brand_profiles(slug, display_name, created_by)
       values ($1,$2,$3) returning id`,
      [requestedSlug, text(value.display_name, "display_name"), actorId],
    );
    parentId = inserted.rows[0].id;
  }
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `creative-brand-version:${parentId}`,
  ]);
  const version = await nextVersion(
    client,
    "creative_brand_versions",
    "brand_profile_id",
    parentId,
  );
  const inserted = await client.query<{ id: string }>(
    `insert into public.creative_brand_versions(brand_profile_id, version, status, config, config_hash, created_by)
     values ($1,$2,'published',$3::jsonb,$4,$5) returning id`,
    [
      parentId,
      version,
      JSON.stringify(config),
      hashCreativePayload(config),
      actorId,
    ],
  );
  return { profileId: parentId, versionId: inserted.rows[0].id, version };
}

async function createChannelVersion(
  client: PoolClient,
  value: JsonRecord,
  actorId: string,
): Promise<{ profileId: string; versionId: string; version: number }> {
  const config = object(value.config, "config");
  const profileId = optionalUuid(value.profile_id, "profile_id");
  let parentId = profileId;
  if (parentId) {
    await lockProfile(
      client,
      "creative_channel_profiles",
      parentId,
      "Channel profile",
    );
  } else {
    const requestedSlug = slug(value.slug, "slug");
    const existing = await client.query<{ id: string }>(
      `select id from public.creative_channel_profiles where slug = $1`,
      [requestedSlug],
    );
    if (existing.rows[0])
      throw new ApiError(
        409,
        "CREATIVE_PROFILE_SLUG_EXISTS",
        "Channel slug đã tồn tại; hãy tạo version mới bằng profile_id.",
      );
    const inserted = await client.query<{ id: string }>(
      `insert into public.creative_channel_profiles(slug, display_name, created_by)
       values ($1,$2,$3) returning id`,
      [requestedSlug, text(value.display_name, "display_name"), actorId],
    );
    parentId = inserted.rows[0].id;
  }
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `creative-channel-version:${parentId}`,
  ]);
  const version = await nextVersion(
    client,
    "creative_channel_versions",
    "channel_profile_id",
    parentId,
  );
  const inserted = await client.query<{ id: string }>(
    `insert into public.creative_channel_versions(channel_profile_id, version, status, config, config_hash, created_by)
     values ($1,$2,'published',$3::jsonb,$4,$5) returning id`,
    [
      parentId,
      version,
      JSON.stringify(config),
      hashCreativePayload(config),
      actorId,
    ],
  );
  return { profileId: parentId, versionId: inserted.rows[0].id, version };
}

async function assertPublishedVersion(
  client: PoolClient,
  table: "creative_brand_versions" | "creative_channel_versions",
  id: string,
  label: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `select id from public.${table} where id = $1 and status = 'published' for share`,
    [id],
  );
  if (!result.rows[0])
    throw new ApiError(
      409,
      "CREATIVE_VERSION_NOT_PUBLISHED",
      `${label} phải là version published.`,
    );
}

async function createTemplateVersion(
  client: PoolClient,
  value: JsonRecord,
  actorId: string,
): Promise<{ templateId: string; versionId: string; version: number }> {
  const config = validateCreativeTemplateConfig(value.config);
  const provider = parseCreativeProviderConfig(config);
  const providerSettings = await getSharedCreativeConfig();
  if (!providerSettings[provider.provider].configured) {
    throw new ApiError(
      409,
      "CREATIVE_PROVIDER_NOT_CONFIGURED",
      `Provider ${provider.provider} chưa được cấu hình trong Settings → AI Creative.`,
    );
  }
  const templateId = optionalUuid(value.template_id, "template_id");
  const binding = object(value.binding, "binding");
  const brandVersionId = optionalUuid(
    binding.brand_version_id,
    "binding.brand_version_id",
  );
  const channelVersionId = optionalUuid(
    binding.channel_version_id,
    "binding.channel_version_id",
  );
  if (!brandVersionId && !channelVersionId) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_TEMPLATE",
      "Template phải bind ít nhất brand hoặc channel version.",
    );
  }
  if (brandVersionId)
    await assertPublishedVersion(
      client,
      "creative_brand_versions",
      brandVersionId,
      "Brand",
    );
  if (channelVersionId)
    await assertPublishedVersion(
      client,
      "creative_channel_versions",
      channelVersionId,
      "Channel",
    );
  let parentId = templateId;
  if (parentId) {
    await lockProfile(
      client,
      "creative_templates",
      parentId,
      "Creative template",
    );
  } else {
    const requestedSlug = slug(value.slug, "slug");
    const existing = await client.query<{ id: string }>(
      `select id from public.creative_templates where slug = $1`,
      [requestedSlug],
    );
    if (existing.rows[0])
      throw new ApiError(
        409,
        "CREATIVE_TEMPLATE_SLUG_EXISTS",
        "Template slug đã tồn tại; hãy tạo version mới bằng template_id.",
      );
    const inserted = await client.query<{ id: string }>(
      `insert into public.creative_templates(slug, display_name, created_by)
       values ($1,$2,$3) returning id`,
      [requestedSlug, text(value.display_name, "display_name"), actorId],
    );
    parentId = inserted.rows[0].id;
  }
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `creative-template-version:${parentId}`,
  ]);
  const version = await nextVersion(
    client,
    "creative_template_versions",
    "template_id",
    parentId,
  );
  const inserted = await client.query<{ id: string }>(
    `insert into public.creative_template_versions(template_id, version, status, template_family, config, config_hash, created_by)
     values ($1,$2,'published',$3,$4::jsonb,$5,$6) returning id`,
    [
      parentId,
      version,
      text(value.template_family, "template_family"),
      JSON.stringify(config),
      hashCreativePayload(config),
      actorId,
    ],
  );
  await client.query(
    `insert into public.creative_template_bindings(template_version_id, brand_version_id, channel_version_id, priority, enabled)
     values ($1,$2,$3,$4,true)`,
    [
      inserted.rows[0].id,
      brandVersionId,
      channelVersionId,
      integer(binding.priority ?? 100, "binding.priority", -10_000, 10_000),
    ],
  );
  return { templateId: parentId, versionId: inserted.rows[0].id, version };
}

async function createBudgetPeriod(
  client: PoolClient,
  value: JsonRecord,
): Promise<{ budgetPeriodId: string }> {
  const brandProfileId = uuid(value.brand_profile_id, "brand_profile_id");
  await lockProfile(
    client,
    "creative_brand_profiles",
    brandProfileId,
    "Brand profile",
  );
  const currency = text(value.currency ?? "USD", "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      "currency phải là ISO-4217.",
    );
  const result = await client.query<{ id: string }>(
    `insert into public.creative_budget_periods(brand_profile_id, period_start, hard_cap_minor, soft_alert_percent, currency)
     values ($1,$2,$3,$4,$5)
     on conflict (brand_profile_id, period_start) do update
       set hard_cap_minor = excluded.hard_cap_minor, soft_alert_percent = excluded.soft_alert_percent, currency = excluded.currency
     returning id`,
    [
      brandProfileId,
      isoDate(value.period_start, "period_start"),
      integer(
        value.hard_cap_minor,
        "hard_cap_minor",
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      integer(value.soft_alert_percent ?? 70, "soft_alert_percent", 1, 99),
      currency,
    ],
  );
  return { budgetPeriodId: result.rows[0].id };
}

function bootstrapTemplateConfig(
  value: JsonRecord,
  provider: string,
  model: string,
  fallbackPrompt: string,
): JsonRecord {
  const prompt = optionalText(value.prompt, "prompt", 8_000) || fallbackPrompt;
  const cost = integer(
    value.reserved_minor ?? 0,
    "reserved_minor",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const size = optionalText(value.size, "size", 16) || "1536x1024";
  const fidelityMode = value.fidelity_mode ?? "reference_generate";
  if (
    fidelityMode !== "reference_generate" &&
    fidelityMode !== "preserve_pixels"
  ) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_TEMPLATE",
      "fidelity_mode phải là reference_generate hoặc preserve_pixels.",
    );
  }
  const config: JsonRecord = {
    prompt,
    fidelity_mode: fidelityMode,
    generation: {
      provider,
      model,
      reserved_minor: cost,
      currency: text(value.currency ?? "USD", "currency", 3).toUpperCase(),
      size,
    },
  };
  if (fidelityMode === "preserve_pixels") {
    const compositor = object(value.compositor, "compositor");
    const productBox = object(compositor.product_box, "compositor.product_box");
    config.compositor = {
      width: integer(compositor.width, "compositor.width", 320, 4096),
      height: integer(compositor.height, "compositor.height", 320, 4096),
      product_box: {
        left: integer(productBox.left, "compositor.product_box.left", 0, 4095),
        top: integer(productBox.top, "compositor.product_box.top", 0, 4095),
        width: integer(
          productBox.width,
          "compositor.product_box.width",
          1,
          4096,
        ),
        height: integer(
          productBox.height,
          "compositor.product_box.height",
          1,
          4096,
        ),
      },
    };
  }
  return validateCreativeTemplateConfig(config);
}

async function bootstrap(
  client: PoolClient,
  value: JsonRecord,
  actorId: string,
) {
  const provider =
    value.provider === "gemini"
      ? "gemini"
      : value.provider === "openai"
        ? "openai"
        : null;
  if (!provider)
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      "provider phải là openai hoặc gemini.",
    );
  const model = text(value.model, "model", 160);
  const brand = await createBrandVersion(
    client,
    {
      slug: value.brand_slug,
      display_name: value.brand_name,
      config: {
        brand_guideline: {
          primary_color:
            optionalText(value.primary_color, "primary_color", 20) || "#1557A0",
          notes: optionalText(value.brand_notes, "brand_notes", 4_000) || "",
        },
      },
    },
    actorId,
  );
  const channel = await createChannelVersion(
    client,
    {
      slug: value.channel_slug,
      display_name: value.channel_name,
      config: {
        aspect_ratio:
          optionalText(value.aspect_ratio, "aspect_ratio", 16) || "16:9",
        output: {
          max_width: integer(value.max_width ?? 1536, "max_width", 320, 4096),
          format: "webp",
          quality: integer(value.quality ?? 82, "quality", 1, 100),
        },
      },
    },
    actorId,
  );
  const thumbnail = await createTemplateVersion(
    client,
    {
      slug: `${slug(value.brand_slug, "brand_slug")}-thumbnail`,
      display_name: `${text(value.brand_name, "brand_name")} — Thumbnail`,
      template_family: "article-thumbnail",
      config: bootstrapTemplateConfig(
        object(value.thumbnail, "thumbnail"),
        provider,
        model,
        "Create a polished editorial hero image for the article. Use a clear focal point, premium composition, and leave clean negative space for an optional headline. No text, logo, or watermark.",
      ),
      binding: {
        brand_version_id: brand.versionId,
        channel_version_id: channel.versionId,
        priority: 10,
      },
    },
    actorId,
  );
  const section = await createTemplateVersion(
    client,
    {
      slug: `${slug(value.brand_slug, "brand_slug")}-section`,
      display_name: `${text(value.brand_name, "brand_name")} — Section`,
      template_family: "article-section",
      config: bootstrapTemplateConfig(
        object(value.section, "section"),
        provider,
        model,
        "Create an editorial supporting image for this article section. Make the visual meaningfully distinct from the hero image while staying within the approved brand direction. No text, logo, or watermark.",
      ),
      binding: {
        brand_version_id: brand.versionId,
        channel_version_id: channel.versionId,
        priority: 10,
      },
    },
    actorId,
  );
  const budget = await createBudgetPeriod(client, {
    brand_profile_id: brand.profileId,
    period_start: value.period_start,
    hard_cap_minor: value.hard_cap_minor,
    soft_alert_percent: value.soft_alert_percent ?? 70,
    currency: value.currency ?? "USD",
  });
  return { brand, channel, thumbnail, section, budget };
}

export async function saveCreativeStudioConfiguration(
  input: unknown,
  actorId: string,
) {
  const value = object(input, "request");
  const kind = value.kind;
  if (
    kind !== "brand-version" &&
    kind !== "channel-version" &&
    kind !== "template-version" &&
    kind !== "budget-period" &&
    kind !== "bootstrap"
  ) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIGURATION",
      "kind không hợp lệ.",
    );
  }
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    let data: unknown;
    if (kind === "brand-version")
      data = await createBrandVersion(client, value, actorId);
    else if (kind === "channel-version")
      data = await createChannelVersion(client, value, actorId);
    else if (kind === "template-version")
      data = await createTemplateVersion(client, value, actorId);
    else if (kind === "budget-period")
      data = await createBudgetPeriod(client, value);
    else data = await bootstrap(client, value, actorId);
    await client.query("commit");
    return data;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCreativeStudioConfiguration() {
  const pool = requireNativeDatabase();
  const [providers, brands, channels, templates, budgets] = await Promise.all([
    getSharedCreativeConfig(),
    pool.query<{
      profile_id: string;
      slug: string;
      display_name: string;
      version_id: string;
      version: number;
      config: JsonRecord;
    }>(
      `select p.id as profile_id, p.slug, p.display_name, v.id as version_id, v.version, v.config
         from public.creative_brand_profiles p
         join public.creative_brand_versions v on v.brand_profile_id = p.id
        where p.status = 'active' and v.status = 'published'
        order by p.display_name, v.version desc`,
    ),
    pool.query<{
      profile_id: string;
      slug: string;
      display_name: string;
      version_id: string;
      version: number;
      config: JsonRecord;
    }>(
      `select p.id as profile_id, p.slug, p.display_name, v.id as version_id, v.version, v.config
         from public.creative_channel_profiles p
         join public.creative_channel_versions v on v.channel_profile_id = p.id
        where p.status = 'active' and v.status = 'published'
        order by p.display_name, v.version desc`,
    ),
    pool.query<{
      template_id: string;
      slug: string;
      display_name: string;
      version_id: string;
      version: number;
      template_family: string;
      config: JsonRecord;
      brand_version_id: string | null;
      channel_version_id: string | null;
      priority: number;
    }>(
      `select t.id as template_id, t.slug, t.display_name, v.id as version_id, v.version, v.template_family, v.config,
              b.brand_version_id, b.channel_version_id, b.priority
         from public.creative_templates t
         join public.creative_template_versions v on v.template_id = t.id
         join public.creative_template_bindings b on b.template_version_id = v.id and b.enabled = true
        where t.status = 'active' and v.status = 'published'
        order by t.display_name, v.version desc, b.priority, b.id`,
    ),
    pool.query<{
      id: string;
      brand_profile_id: string;
      period_start: string;
      hard_cap_minor: string;
      currency: string;
      committed_minor: string;
    }>(
      `select b.id, b.brand_profile_id, b.period_start::text, b.hard_cap_minor::text, b.currency,
              coalesce(sum(case
                when r.status in ('settled','resolved_spent') then coalesce(r.actual_minor, r.reserved_minor)
                when r.status in ('reserved','held_unknown') then r.reserved_minor else 0 end), 0)::text as committed_minor
         from public.creative_budget_periods b
         left join public.creative_budget_reservations r on r.budget_period_id = b.id
        group by b.id
        order by b.period_start desc, b.created_at desc`,
    ),
  ]);
  const hasTemplate = templates.rows.length > 0;
  const planningReady =
    brands.rows.length > 0 &&
    channels.rows.length > 0 &&
    hasTemplate &&
    budgets.rows.length > 0;
  return {
    providers: {
      openai: {
        configured: providers.openai.configured,
        model: providers.openai.model,
      },
      gemini: {
        configured: providers.gemini.configured,
        model: providers.gemini.model,
      },
      configured: providers.configured,
    },
    brands: brands.rows,
    channels: channels.rows,
    templates: templates.rows,
    budgets: budgets.rows,
    readiness: {
      providers: providers.configured,
      brand: brands.rows.length > 0,
      channel: channels.rows.length > 0,
      template: hasTemplate,
      budget: budgets.rows.length > 0,
      // A Library-only request must remain possible when a provider is
      // intentionally disabled.  The request transaction itself refuses only
      // the unresolved slots that would actually need AI generation.
      ready: planningReady,
      generation: providers.configured && planningReady,
    },
  };
}

export const CREATIVE_CONFIGURATION_KINDS: readonly ResourceKind[] = [
  "brand-version",
  "channel-version",
  "template-version",
  "budget-period",
  "bootstrap",
];
