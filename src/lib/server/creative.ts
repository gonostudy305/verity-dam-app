import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import {
  CREATIVE_PAYLOAD_HASH_VERSION,
  hashCreativePayload,
  normalizeCreativeArticlePayload,
  planCreativeSlots,
  type CreativeArticlePayload,
} from "@/lib/creative";
import {
  compileCreativePrompt,
  parseCreativeProviderConfig,
  parsePreservePixelsLayout,
} from "@/lib/creative-generation";
import { isUuid } from "@/lib/media-api";
import { ApiError, notFound } from "./http";
import { getSharedCreativeConfig } from "./creative-config";
import { requireNativeDatabase } from "./native-db";
import { deleteR2ObjectByKey, getR2ObjectByKey, putR2ObjectByKey } from "./r2";

type RequestRow = {
  id: string;
  payload_hash: string;
  status: string;
  external_revision: string | null;
};

function assertText(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(
      400,
      "INVALID_CREATIVE_REQUEST",
      `${field} là bắt buộc.`,
    );
  return value.trim();
}

function assertOptionalUuid(value: unknown, field: string) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !isUuid(value))
    throw new ApiError(
      400,
      "INVALID_CREATIVE_REQUEST",
      `${field} không hợp lệ.`,
    );
  return value;
}

export function parseCreativeArticlePayload(
  body: unknown,
): CreativeArticlePayload {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiError(
      400,
      "INVALID_CREATIVE_REQUEST",
      "Nội dung creative job không hợp lệ.",
    );
  const raw = body as Record<string, unknown>;
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map((section, index) => {
        if (!section || typeof section !== "object" || Array.isArray(section))
          throw new ApiError(
            400,
            "INVALID_CREATIVE_REQUEST",
            `sections[${index}] không hợp lệ.`,
          );
        const value = section as Record<string, unknown>;
        return {
          id: assertText(
            value.id ?? `section-${index + 1}`,
            `sections[${index}].id`,
          ),
          heading: typeof value.heading === "string" ? value.heading : "",
          body: typeof value.body === "string" ? value.body : "",
          product_id: assertOptionalUuid(
            value.product_id,
            `sections[${index}].product_id`,
          ),
        };
      })
    : [];
  const seenSectionIds = new Set<string>();
  for (const section of sections) {
    if (seenSectionIds.has(section.id))
      throw new ApiError(
        400,
        "DUPLICATE_SECTION_ID",
        `Section ID bị trùng: ${section.id}.`,
      );
    seenSectionIds.add(section.id);
  }
  const maxSectionImages =
    raw.max_section_images == null ? undefined : Number(raw.max_section_images);
  if (
    maxSectionImages !== undefined &&
    (!Number.isFinite(maxSectionImages) || maxSectionImages < 0)
  ) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_REQUEST",
      "max_section_images không hợp lệ.",
    );
  }
  if (raw.source_policy != null) {
    throw new ApiError(
      400,
      "SOURCE_POLICY_SERVER_OWNED",
      "source_policy được xác định bởi cấu hình server.",
    );
  }
  return {
    external_source: assertText(raw.external_source, "external_source"),
    external_article_id: assertText(
      raw.external_article_id,
      "external_article_id",
    ),
    external_revision: assertText(raw.external_revision, "external_revision"),
    supersedes_revision:
      raw.supersedes_revision == null
        ? null
        : assertText(raw.supersedes_revision, "supersedes_revision"),
    brand_version_id:
      assertOptionalUuid(raw.brand_version_id, "brand_version_id") || "",
    channel_version_id:
      assertOptionalUuid(raw.channel_version_id, "channel_version_id") || "",
    budget_period_id: assertOptionalUuid(
      raw.budget_period_id,
      "budget_period_id",
    ),
    title: assertText(raw.title, "title"),
    body: typeof raw.body === "string" ? raw.body : "",
    product_id: assertOptionalUuid(raw.product_id, "product_id"),
    thumbnail_template_version_id:
      assertOptionalUuid(
        raw.thumbnail_template_version_id,
        "thumbnail_template_version_id",
      ) || "",
    section_template_version_id:
      assertOptionalUuid(
        raw.section_template_version_id,
        "section_template_version_id",
      ) || "",
    max_section_images: maxSectionImages,
    source_policy: raw.source_policy as Record<string, unknown> | undefined,
    sections,
  };
}

function slotSeed(requestId: string, slotKey: string) {
  return createHash("sha256")
    .update(`${requestId}:${slotKey}`, "utf8")
    .digest("hex");
}

async function getRequestByIdempotency(
  client: PoolClient,
  source: string,
  key: string,
) {
  return client.query<RequestRow>(
    `select id, payload_hash, status, external_revision
       from public.creative_requests
      where external_source = $1 and idempotency_key = $2
      limit 1`,
    [source, key],
  );
}

async function assertPublishedCreativeConfiguration(
  client: PoolClient,
  payload: ReturnType<typeof normalizeCreativeArticlePayload>,
) {
  const brand = await client.query<{ id: string; brand_profile_id: string }>(
    `select v.id, p.id as brand_profile_id
       from public.creative_brand_versions v
       join public.creative_brand_profiles p on p.id = v.brand_profile_id
      where v.id = $1 and v.status = 'published' and p.status = 'active'
      for share of v, p`,
    [payload.brand_version_id],
  );
  if (!brand.rows[0])
    throw new ApiError(
      409,
      "BRAND_VERSION_NOT_PUBLISHED",
      "Brand version không còn sẵn sàng cho request mới.",
    );

  if (!payload.budget_period_id) {
    throw new ApiError(
      409,
      "BUDGET_PERIOD_REQUIRED",
      "AI Creative request cần budget period của brand hiện hành.",
    );
  }
  const budget = await client.query<{ id: string }>(
    `select id from public.creative_budget_periods
      where id = $1 and brand_profile_id = $2
      for share`,
    [payload.budget_period_id, brand.rows[0].brand_profile_id],
  );
  if (!budget.rows[0]) {
    throw new ApiError(
      409,
      "BUDGET_PERIOD_NOT_OWNED_BY_BRAND",
      "Budget period không thuộc brand version được chọn.",
    );
  }

  const channel = await client.query<{ id: string }>(
    `select v.id
       from public.creative_channel_versions v
       join public.creative_channel_profiles p on p.id = v.channel_profile_id
      where v.id = $1 and v.status = 'published' and p.status = 'active'
      for share of v, p`,
    [payload.channel_version_id],
  );
  if (!channel.rows[0])
    throw new ApiError(
      409,
      "CHANNEL_VERSION_NOT_PUBLISHED",
      "Channel version không còn sẵn sàng cho request mới.",
    );

  const templateIds = [
    ...new Set([
      payload.thumbnail_template_version_id,
      payload.section_template_version_id,
    ]),
  ];
  for (const templateId of templateIds) {
    const template = await client.query<{ id: string }>(
      `select tv.id
         from public.creative_template_versions tv
         join public.creative_template_bindings b on b.template_version_id = tv.id
        where tv.id = $1
          and tv.status = 'published'
          and b.enabled = true
          and (b.brand_version_id is null or b.brand_version_id = $2)
          and (b.channel_version_id is null or b.channel_version_id = $3)
        order by
          (b.brand_version_id is not null)::int + (b.channel_version_id is not null)::int desc,
          b.priority asc,
          b.id asc
        limit 1
        for share of tv, b`,
      [templateId, payload.brand_version_id, payload.channel_version_id],
    );
    if (!template.rows[0]) {
      throw new ApiError(
        409,
        "TEMPLATE_VERSION_NOT_BOUND",
        "Template version phải published và được bind với brand/channel hiện hành.",
      );
    }
  }
}

async function findEligibleLibraryAsset(
  client: PoolClient,
  slotId: string,
  requestedAssetId?: string,
) {
  return client.query<{ media_asset_id: string }>(
    `select e.media_asset_id
       from public.creative_slots s
       join public.creative_requests q on q.id = s.request_id
       join public.creative_library_asset_eligibilities e
         on e.brand_version_id = q.brand_version_id
        and e.status = 'active'
        and (e.channel_version_id is null or e.channel_version_id = q.channel_version_id)
        and (s.target_product_id is null or e.product_id = s.target_product_id)
       join public.media_assets a on a.id = e.media_asset_id
      where s.id = $1
        and a.deleted_at is null
        and a.review_state = 'approved'
        and ($2::uuid is null or e.media_asset_id = $2::uuid)
        and not exists (
          select 1
            from public.creative_placement_usages u
           where u.media_asset_id = e.media_asset_id
             and u.channel_version_id = q.channel_version_id
             and u.published_at > now() - interval '14 days'
        )
      order by
        (e.product_id is not null)::int desc,
        (e.channel_version_id is not null)::int desc,
        e.score_bias desc,
        e.created_at asc,
        e.media_asset_id asc
      limit 1
      for share of s, q, e, a`,
    [slotId, requestedAssetId || null],
  );
}

async function activateEligibleLibraryResolution(
  client: PoolClient,
  slotId: string,
  mediaAssetId: string,
  actorId: string,
) {
  const eligible = await findEligibleLibraryAsset(client, slotId, mediaAssetId);
  if (!eligible.rows[0]) {
    throw new ApiError(
      409,
      "LIBRARY_ASSET_NOT_ELIGIBLE",
      "Asset chưa được cấp eligibility cho brand/product/channel hoặc đang trong cooldown.",
    );
  }
  await client.query(
    `update public.creative_slot_resolutions
        set status = 'superseded', updated_at = now()
      where slot_id = $1 and status in ('proposed', 'active')`,
    [slotId],
  );
  const result = await client.query<{ id: string }>(
    `insert into public.creative_slot_resolutions(slot_id, source_kind, media_asset_id, status, resolved_at, resolved_by)
     values ($1, 'library', $2, 'active', now(), $3)
     returning id`,
    [slotId, mediaAssetId, actorId],
  );
  await client.query(
    `select public.recompute_creative_slots(array[$1::uuid])`,
    [slotId],
  );
  return result.rows[0].id;
}

async function resolveRequestLibraryFirst(
  client: PoolClient,
  requestId: string,
  actorId: string,
) {
  const slots = await client.query<{ id: string }>(
    `select id from public.creative_slots where request_id = $1 order by id for update`,
    [requestId],
  );
  const resolutionIds: string[] = [];
  for (const slot of slots.rows) {
    const eligible = await findEligibleLibraryAsset(client, slot.id);
    if (eligible.rows[0]) {
      resolutionIds.push(
        await activateEligibleLibraryResolution(
          client,
          slot.id,
          eligible.rows[0].media_asset_id,
          actorId,
        ),
      );
    }
  }
  return resolutionIds;
}

async function queueCreativeGenerationForSlotInTransaction(
  client: PoolClient,
  slotId: string,
  actorId: string,
) {
  const slot = await client.query<{
    id: string;
    request_id: string;
    template_config: Record<string, unknown>;
    content_snapshot: Record<string, unknown>;
    brand_config: Record<string, unknown>;
    channel_config: Record<string, unknown>;
    fidelity_mode: string;
    budget_period_id: string | null;
    target_product_id: string | null;
    has_resolution: boolean;
  }>(
    `select s.id, s.request_id, tv.config as template_config, bv.config as brand_config, cv.config as channel_config,
            s.content_snapshot, s.fidelity_mode, s.target_product_id,
            q.budget_period_id,
            exists(select 1 from public.creative_slot_resolutions r where r.slot_id = s.id and r.status in ('proposed', 'active')) as has_resolution
       from public.creative_slots s
       join public.creative_requests q on q.id = s.request_id
       join public.creative_template_versions tv on tv.id = s.template_version_id
       join public.creative_brand_versions bv on bv.id = q.brand_version_id
       join public.creative_channel_versions cv on cv.id = q.channel_version_id
      where s.id = $1
      for update of s, q, tv, bv, cv`,
    [slotId],
  );
  const row = slot.rows[0];
  if (!row) throw notFound("Không tìm thấy creative slot.");
  if (row.has_resolution) return null;
  if (!row.budget_period_id) {
    throw new ApiError(
      409,
      "BUDGET_PERIOD_REQUIRED",
      "AI generation cần budget period để enforce hard cap.",
    );
  }
  const provider = parseCreativeProviderConfig(row.template_config);
  const configuredProviders = await getSharedCreativeConfig();
  if (!configuredProviders[provider.provider].configured) {
    throw new ApiError(
      409,
      "CREATIVE_PROVIDER_NOT_CONFIGURED",
      `Provider ${provider.provider} chưa được cấu hình trong Settings → AI Creative.`,
    );
  }
  const compiled = compileCreativePrompt(
    row.template_config,
    row.content_snapshot,
    row.fidelity_mode,
    row.brand_config,
    row.channel_config,
  );
  const references =
    row.target_product_id &&
    ["reference_generate", "preserve_pixels"].includes(row.fidelity_mode)
      ? await client.query<{
          media_asset_id: string;
          storage_path: string;
          content_hash: string | null;
          reference_role: string;
        }>(
          `select r.media_asset_id, a.storage_path, a.content_hash, r.reference_role
         from public.creative_product_references r
         join public.media_assets a on a.id = r.media_asset_id
        where r.product_id = $1
          and r.status = 'approved'
          and r.reference_role in ${row.fidelity_mode === "preserve_pixels" ? "('cutout')" : "('identity', 'cutout')"}
          and a.review_state = 'approved'
          and a.deleted_at is null
          and coalesce(a.ai_flags -> 'is_ai', 'false'::jsonb) <> 'true'::jsonb
        order by case r.reference_role when 'identity' then 0 else 1 end, r.id`,
          [row.target_product_id],
        )
      : {
          rows: [] as Array<{
            media_asset_id: string;
            storage_path: string;
            content_hash: string | null;
            reference_role: string;
          }>,
        };
  if (row.fidelity_mode === "preserve_pixels" && !row.target_product_id) {
    throw new ApiError(
      409,
      "PRODUCT_CUTOUT_REQUIRED",
      "preserve_pixels cần SKU với product cutout thật đã được phê duyệt.",
    );
  }
  if (
    row.target_product_id &&
    ["reference_generate", "preserve_pixels"].includes(row.fidelity_mode) &&
    references.rows.length === 0
  ) {
    throw new ApiError(
      409,
      "PRODUCT_REFERENCE_REQUIRED",
      row.fidelity_mode === "preserve_pixels"
        ? "preserve_pixels cần product cutout thật đã được phê duyệt."
        : "reference_generate cần product reference thật đã được phê duyệt.",
    );
  }
  const preservePixelsLayout =
    row.fidelity_mode === "preserve_pixels"
      ? parsePreservePixelsLayout(row.template_config)
      : null;
  const previous = await client.query<{ attempt_no: number }>(
    `select attempt_no
       from public.ai_image_generations
      where slot_id = $1
      order by attempt_no desc
      limit 1
      for update`,
    [slotId],
  );
  const attemptNo = (previous.rows[0]?.attempt_no || 0) + 1;
  const generation = await client.query<{ id: string }>(
    `insert into public.ai_image_generations
       (slot_id, attempt_no, provider, model, provider_config_snapshot, prompt_manifest, prompt_hash, reference_manifest)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb)
     returning id`,
    [
      slotId,
      attemptNo,
      provider.provider,
      provider.model,
      JSON.stringify(provider),
      JSON.stringify(compiled.manifest),
      compiled.hash,
      JSON.stringify({
        roles: references.rows.map((reference) => ({
          media_asset_id: reference.media_asset_id,
          storage_path: reference.storage_path,
          sha256: reference.content_hash,
          role: reference.reference_role,
        })),
        policy: "approved-real-only",
      }),
    ],
  );
  const generationId = generation.rows[0].id;
  await client.query(
    `insert into public.creative_generation_jobs(generation_id, idempotency_key, payload)
     values ($1,$2,$3::jsonb)`,
    [
      generationId,
      `creative:generate:${generationId}`,
      JSON.stringify({
        reserved_minor: provider.reserved_minor,
        currency: provider.currency,
        size: provider.size || null,
        queued_by: actorId,
        compositor: preservePixelsLayout,
      }),
    ],
  );
  await client.query(
    `update public.creative_slots set status = 'generating', updated_at = now() where id = $1`,
    [slotId],
  );
  await client.query(
    `update public.creative_requests set status = case when status = 'superseded_for_placement' then status else 'generating' end, updated_at = now() where id = $1`,
    [row.request_id],
  );
  await client.query(
    `insert into public.creative_audit_events(request_id, generation_id, event_type, actor_id, payload)
     values ($1,$2,'generation_queued',$3,$4::jsonb)`,
    [
      row.request_id,
      generationId,
      actorId,
      JSON.stringify({
        provider: provider.provider,
        model: provider.model,
        reserved_minor: provider.reserved_minor,
      }),
    ],
  );
  return generationId;
}

export async function queueCreativeGenerationForSlot(
  slotId: string,
  actorId: string,
) {
  if (!isUuid(slotId))
    throw new ApiError(400, "INVALID_ID", "Creative slot không hợp lệ.");
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    const generationId = await queueCreativeGenerationForSlotInTransaction(
      client,
      slotId,
      actorId,
    );
    await client.query("commit");
    return { generationId, queued: Boolean(generationId) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function retryCreativeGeneration(
  generationId: string,
  actorId: string,
) {
  if (!isUuid(generationId))
    throw new ApiError(400, "INVALID_ID", "Generation không hợp lệ.");
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    const previous = await client.query<{
      id: string;
      slot_id: string;
      provider: string;
      model: string;
      provider_config_snapshot: Record<string, unknown>;
      prompt_manifest: Record<string, unknown>;
      prompt_hash: string;
      reference_manifest: Record<string, unknown>;
      provider_call_state: string;
      retry_class: string | null;
      job_status: string | null;
    }>(
      `select g.id, g.slot_id, g.provider, g.model, g.provider_config_snapshot, g.prompt_manifest, g.prompt_hash,
              g.reference_manifest, g.provider_call_state, g.retry_class, j.status as job_status
         from public.ai_image_generations g
         join public.creative_generation_jobs j on j.generation_id = g.id
        where g.id = $1
        for update of g, j`,
      [generationId],
    );
    const row = previous.rows[0];
    if (!row) throw notFound("Không tìm thấy generation.");
    if (
      row.provider_call_state !== "failed" ||
      row.job_status !== "failed" ||
      row.retry_class === "ambiguous"
    ) {
      throw new ApiError(
        409,
        "GENERATION_RETRY_FORBIDDEN",
        "Chỉ generation terminal failed (không ambiguous) mới có thể tạo attempt mới.",
      );
    }
    const provider = parseCreativeProviderConfig(row.provider_config_snapshot);
    const number = await client.query<{ attempt_no: number }>(
      `select attempt_no from public.ai_image_generations where slot_id = $1 order by attempt_no desc limit 1 for update`,
      [row.slot_id],
    );
    const inserted = await client.query<{ id: string }>(
      `insert into public.ai_image_generations
         (slot_id, attempt_no, provider, model, provider_config_snapshot, prompt_manifest, prompt_hash, reference_manifest, retry_of_generation_id)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9)
       on conflict (retry_of_generation_id) where retry_of_generation_id is not null do nothing
       returning id`,
      [
        row.slot_id,
        (number.rows[0]?.attempt_no || 0) + 1,
        row.provider,
        row.model,
        JSON.stringify(row.provider_config_snapshot),
        JSON.stringify(row.prompt_manifest),
        row.prompt_hash,
        JSON.stringify(row.reference_manifest),
        generationId,
      ],
    );
    let retryId = inserted.rows[0]?.id;
    const replayed = !retryId;
    if (!retryId) {
      const existing = await client.query<{ id: string }>(
        `select id from public.ai_image_generations where retry_of_generation_id = $1 for share`,
        [generationId],
      );
      retryId = existing.rows[0]?.id;
      if (!retryId)
        throw new ApiError(
          409,
          "GENERATION_RETRY_CONFLICT",
          "Không thể xác định attempt retry hiện hữu.",
        );
    } else {
      await client.query(
        `insert into public.creative_generation_jobs(generation_id, idempotency_key, payload)
         values ($1,$2,$3::jsonb)`,
        [
          retryId,
          `creative:generate:${retryId}`,
          JSON.stringify({
            reserved_minor: provider.reserved_minor,
            currency: provider.currency,
            size: provider.size || null,
            queued_by: actorId,
            retry_of: generationId,
          }),
        ],
      );
      await client.query(
        `select public.recompute_creative_slots(array[$1::uuid])`,
        [row.slot_id],
      );
      await client.query(
        `insert into public.creative_audit_events(generation_id, event_type, actor_id, payload)
         values ($1,'generation_retried',$2,$3::jsonb)`,
        [retryId, actorId, JSON.stringify({ retry_of: generationId })],
      );
    }
    await client.query("commit");
    return { generationId: retryId, replayed };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveCreativeBudgetEvent(
  reservationId: string,
  resolution: "spent" | "not_spent",
  actorId: string,
  reason: string,
  actualMinor?: number,
) {
  if (!isUuid(reservationId))
    throw new ApiError(400, "INVALID_ID", "Budget event không hợp lệ.");
  if (!reason.trim())
    throw new ApiError(
      400,
      "RESOLUTION_REASON_REQUIRED",
      "Cần ghi lý do reconciliation.",
    );
  if (
    actualMinor != null &&
    (!Number.isSafeInteger(actualMinor) || actualMinor < 0)
  )
    throw new ApiError(
      400,
      "INVALID_ACTUAL_COST",
      "actual_minor không hợp lệ.",
    );
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    const reservation = await client.query<{
      id: string;
      generation_id: string;
      reserved_minor: number;
      request_id: string;
    }>(
      `select b.id, b.generation_id, b.reserved_minor, s.request_id
         from public.creative_budget_reservations b
         join public.ai_image_generations g on g.id = b.generation_id
         join public.creative_slots s on s.id = g.slot_id
        where b.id = $1 for update`,
      [reservationId],
    );
    const row = reservation.rows[0];
    if (!row) throw notFound("Không tìm thấy budget event.");
    const result = await client.query<{ id: string }>(
      `update public.creative_budget_reservations
          set status = $2,
              actual_minor = $3,
              resolution_reason = $4,
              resolved_by = $5,
              resolved_at = now(),
              updated_at = now()
        where id = $1 and status = 'held_unknown'
        returning id`,
      [
        reservationId,
        resolution === "spent" ? "resolved_spent" : "resolved_not_spent",
        resolution === "spent" ? (actualMinor ?? row.reserved_minor) : 0,
        reason.trim().slice(0, 1000),
        actorId,
      ],
    );
    if (!result.rows[0])
      throw new ApiError(
        409,
        "BUDGET_EVENT_NOT_HELD_UNKNOWN",
        "Chỉ budget event held_unknown mới cần resolve.",
      );
    await client.query(
      `insert into public.creative_audit_events(request_id, generation_id, event_type, actor_id, payload)
       values ($1,$2,'budget_reconciled',$3,$4::jsonb)`,
      [
        row.request_id,
        row.generation_id,
        actorId,
        JSON.stringify({
          reservation_id: reservationId,
          resolution,
          actual_minor:
            resolution === "spent" ? (actualMinor ?? row.reserved_minor) : 0,
          reason: reason.trim().slice(0, 1000),
        }),
      ],
    );
    await client.query("commit");
    return {
      reservationId,
      status: resolution === "spent" ? "resolved_spent" : "resolved_not_spent",
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function createCreativeArticleJob(
  input: CreativeArticlePayload,
  idempotencyKey: string,
  actorId: string,
) {
  const normalized = normalizeCreativeArticlePayload(input);
  const payloadHash = hashCreativePayload(normalized);
  const normalizedKey = assertText(idempotencyKey, "Idempotency-Key");
  const pool = requireNativeDatabase();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const source = String(normalized.external_source);
    const articleId = String(normalized.external_article_id);
    // Serialize both idempotency and article-head races without relying on a
    // client-provided revision ordering scheme.
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`creative:idempotency:${source}:${normalizedKey}`],
    );
    await client.query(
      `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`creative:article:${source}:${articleId}`],
    );

    const existing = await getRequestByIdempotency(
      client,
      source,
      normalizedKey,
    );
    if (existing.rows[0]) {
      if (existing.rows[0].payload_hash !== payloadHash) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key đã được dùng cho payload khác.",
        );
      }
      await client.query("commit");
      return {
        requestId: existing.rows[0].id,
        replayed: true,
        status: existing.rows[0].status,
      };
    }

    const duplicateRevision = await client.query<RequestRow>(
      `select id, payload_hash, status, external_revision
         from public.creative_requests
        where external_source = $1 and external_article_id = $2 and external_revision = $3
        limit 1`,
      [source, articleId, normalized.external_revision],
    );
    if (duplicateRevision.rows[0]) {
      if (duplicateRevision.rows[0].payload_hash !== payloadHash) {
        throw new ApiError(
          409,
          "REVISION_CONFLICT",
          "Revision đã tồn tại với nội dung khác.",
        );
      }
      await client.query("commit");
      return {
        requestId: duplicateRevision.rows[0].id,
        replayed: true,
        status: duplicateRevision.rows[0].status,
      };
    }

    const head = await client.query<{
      current_revision: string;
      current_request_id: string;
    }>(
      `select current_revision, current_request_id
         from public.creative_article_heads
        where external_source = $1 and external_article_id = $2
        for update`,
      [source, articleId],
    );
    const current = head.rows[0];
    if (
      current
        ? String(normalized.supersedes_revision || "") !==
          current.current_revision
        : normalized.supersedes_revision
    ) {
      throw new ApiError(
        409,
        "REVISION_CONFLICT",
        "supersedes_revision không khớp revision hiện hành.",
      );
    }

    await assertPublishedCreativeConfiguration(client, normalized);

    const inserted = await client.query<{ id: string }>(
      `insert into public.creative_requests
        (brand_version_id, channel_version_id, budget_period_id, external_source, external_article_id, external_revision,
         supersedes_revision, idempotency_key, payload_hash, payload_hash_version, payload, policy_snapshot, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)
       returning id`,
      [
        normalized.brand_version_id,
        normalized.channel_version_id,
        normalized.budget_period_id,
        source,
        articleId,
        normalized.external_revision,
        normalized.supersedes_revision || null,
        normalizedKey,
        payloadHash,
        CREATIVE_PAYLOAD_HASH_VERSION,
        JSON.stringify(normalized),
        JSON.stringify(normalized.source_policy),
        actorId,
      ],
    );
    const requestId = inserted.rows[0].id;
    const slots = planCreativeSlots(normalized);
    for (const slot of slots) {
      const fidelity = await client.query<{ fidelity_mode: string | null }>(
        `select nullif(config ->> 'fidelity_mode', '') as fidelity_mode
           from public.creative_template_versions
          where id = $1
          for share`,
        [slot.templateVersionId],
      );
      const fidelityMode =
        fidelity.rows[0]?.fidelity_mode || "reference_generate";
      if (
        fidelityMode !== "reference_generate" &&
        fidelityMode !== "preserve_pixels"
      ) {
        throw new ApiError(
          409,
          "INVALID_TEMPLATE_FIDELITY_MODE",
          "Template có fidelity_mode không hợp lệ.",
        );
      }
      await client.query(
        `insert into public.creative_slots
          (request_id, slot_key, slot_kind, template_version_id, template_selection_reason, selection_seed,
           target_product_id, source_policy, fidelity_mode, content_snapshot)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10::jsonb)`,
        [
          requestId,
          slot.slotKey,
          slot.slotKind,
          slot.templateVersionId,
          JSON.stringify({
            planner: "deterministic-v1",
            reason: "request template snapshot",
          }),
          slotSeed(requestId, slot.slotKey),
          slot.targetProductId,
          JSON.stringify(normalized.source_policy),
          fidelityMode,
          JSON.stringify(slot.contentSnapshot),
        ],
      );
    }
    const libraryResolutionIds = await resolveRequestLibraryFirst(
      client,
      requestId,
      actorId,
    );
    const unresolvedSlots = await client.query<{ id: string }>(
      `select s.id
         from public.creative_slots s
        where s.request_id = $1
          and not exists (select 1 from public.creative_slot_resolutions r where r.slot_id = s.id and r.status = 'active')
        order by s.slot_key`,
      [requestId],
    );
    const generationIds: string[] = [];
    for (const slot of unresolvedSlots.rows) {
      const generationId = await queueCreativeGenerationForSlotInTransaction(
        client,
        slot.id,
        actorId,
      );
      if (generationId) generationIds.push(generationId);
    }
    if (current) {
      await client.query(
        `update public.creative_requests set status = 'superseded_for_placement', updated_at = now() where id = $1`,
        [current.current_request_id],
      );
    }
    await client.query(
      `insert into public.creative_article_heads(external_source, external_article_id, current_revision, current_request_id)
       values ($1,$2,$3,$4)
       on conflict (external_source, external_article_id)
       do update set current_revision = excluded.current_revision, current_request_id = excluded.current_request_id, updated_at = now()`,
      [source, articleId, normalized.external_revision, requestId],
    );
    await client.query(
      `insert into public.creative_audit_events(request_id, event_type, actor_id, payload) values ($1, 'request_created', $2, $3::jsonb)`,
      [
        requestId,
        actorId,
        JSON.stringify({
          payload_hash: payloadHash,
          library_resolution_count: libraryResolutionIds.length,
          generation_count: generationIds.length,
        }),
      ],
    );
    await client.query("commit");
    return { requestId, replayed: false, status: "planning" };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function activateLibraryResolution(
  slotId: string,
  mediaAssetId: string,
  actorId: string,
) {
  if (!isUuid(slotId) || !isUuid(mediaAssetId))
    throw new ApiError(
      400,
      "INVALID_ID",
      "Slot hoặc media asset không hợp lệ.",
    );
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    const slot = await client.query<{ id: string }>(
      `select id from public.creative_slots where id = $1 for update`,
      [slotId],
    );
    if (!slot.rows[0]) throw notFound("Không tìm thấy creative slot.");
    const resolutionId = await activateEligibleLibraryResolution(
      client,
      slotId,
      mediaAssetId,
      actorId,
    );
    await client.query("commit");
    return { resolutionId };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCreativePlacementManifest(requestId: string) {
  if (!isUuid(requestId))
    throw new ApiError(400, "INVALID_ID", "Creative request không hợp lệ.");
  const current = await requireNativeDatabase().query<{ exists: boolean }>(
    `select exists(
       select 1 from public.creative_requests q
       join public.creative_article_heads h
         on h.external_source = q.external_source
        and h.external_article_id = q.external_article_id
        and h.current_request_id = q.id
       where q.id = $1
     ) as exists`,
    [requestId],
  );
  if (!current.rows[0]?.exists)
    throw new ApiError(
      409,
      "REVISION_SUPERSEDED",
      "Chỉ revision hiện hành mới có placement manifest.",
    );
  const result = await requireNativeDatabase().query<{
    slot_key: string;
    slot_kind: string;
    media_asset_id: string;
    file_url: string;
    thumbnail_url: string;
    external_article_id: string | null;
    external_revision: string | null;
  }>(
    `select s.slot_key, s.slot_kind, r.media_asset_id, a.file_url, a.thumbnail_url, q.external_article_id, q.external_revision
       from public.creative_requests q
       join public.creative_slots s on s.request_id = q.id
       join public.creative_slot_resolutions r on r.slot_id = s.id and r.status = 'active'
       join public.media_assets a on a.id = r.media_asset_id and a.review_state = 'approved' and a.deleted_at is null
      where q.id = $1
      order by s.slot_key`,
    [requestId],
  );
  return result.rows;
}

export async function listCreativeRequests(limit = 25) {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await requireNativeDatabase().query<{
    id: string;
    status: string;
    external_source: string;
    external_article_id: string | null;
    external_revision: string | null;
    created_at: string;
    total_slots: number;
    resolved_slots: number;
    awaiting_review_slots: number;
  }>(
    `select q.id, q.status, q.external_source, q.external_article_id, q.external_revision, q.created_at,
            count(s.id)::int as total_slots,
            count(*) filter (where s.status = 'resolved')::int as resolved_slots,
            count(*) filter (where s.status = 'awaiting_review')::int as awaiting_review_slots
       from public.creative_requests q
       left join public.creative_slots s on s.request_id = q.id
      group by q.id
      order by q.created_at desc
      limit $1`,
    [bounded],
  );
  return result.rows;
}

/** Contributor-safe operational read model. Temp R2 keys never leave this service. */
export async function getCreativeRequestDetail(requestId: string) {
  if (!isUuid(requestId))
    throw new ApiError(400, "INVALID_ID", "Creative request không hợp lệ.");
  const pool = requireNativeDatabase();
  const request = await pool.query<{
    id: string;
    status: string;
    external_source: string;
    external_article_id: string | null;
    external_revision: string | null;
    supersedes_revision: string | null;
    created_at: string;
    updated_at: string;
    brand_name: string;
    brand_version: number;
    channel_name: string;
    channel_version: number;
    budget_period_id: string | null;
  }>(
    `select q.id, q.status, q.external_source, q.external_article_id, q.external_revision, q.supersedes_revision, q.created_at, q.updated_at,
            bp.display_name as brand_name, bv.version as brand_version, cp.display_name as channel_name, cv.version as channel_version,
            q.budget_period_id
       from public.creative_requests q
       join public.creative_brand_versions bv on bv.id = q.brand_version_id
       join public.creative_brand_profiles bp on bp.id = bv.brand_profile_id
       join public.creative_channel_versions cv on cv.id = q.channel_version_id
       join public.creative_channel_profiles cp on cp.id = cv.channel_profile_id
      where q.id = $1`,
    [requestId],
  );
  const root = request.rows[0];
  if (!root) throw notFound("Không tìm thấy creative job.");
  const [slots, generations, outputs, resolutions, budgetEvents] =
    await Promise.all([
      pool.query<{
        id: string;
        slot_key: string;
        slot_kind: string;
        status: string;
        fidelity_mode: string;
        target_product_id: string | null;
        content_snapshot: Record<string, unknown>;
        template_name: string;
        template_version: number;
      }>(
        `select s.id, s.slot_key, s.slot_kind, s.status, s.fidelity_mode, s.target_product_id, s.content_snapshot,
              t.display_name as template_name, tv.version as template_version
         from public.creative_slots s
         join public.creative_template_versions tv on tv.id = s.template_version_id
         join public.creative_templates t on t.id = tv.template_id
        where s.request_id = $1 order by s.slot_key`,
        [requestId],
      ),
      pool.query<{
        id: string;
        slot_id: string;
        attempt_no: number;
        provider: string;
        model: string;
        provider_call_state: string;
        retry_class: string | null;
        error_code: string | null;
        error_detail: string | null;
        started_at: string | null;
        completed_at: string | null;
        job_status: string | null;
      }>(
        `select g.id, g.slot_id, g.attempt_no, g.provider, g.model, g.provider_call_state, g.retry_class,
              g.error_code, g.error_detail, g.started_at, g.completed_at, j.status as job_status
         from public.ai_image_generations g
         join public.creative_slots s on s.id = g.slot_id
         left join public.creative_generation_jobs j on j.generation_id = g.id
        where s.request_id = $1 order by g.slot_id, g.attempt_no`,
        [requestId],
      ),
      pool.query<{
        id: string;
        generation_id: string;
        candidate_index: number;
        creative_state: string;
        review_state: string;
        expires_at: string;
        media_asset_id: string | null;
        created_at: string;
        dimensions: Record<string, unknown> | null;
      }>(
        `select o.id, o.generation_id, o.candidate_index, o.creative_state, o.review_state, o.expires_at,
              o.media_asset_id, o.created_at, o.provenance -> 'dimensions' as dimensions
         from public.ai_image_generation_outputs o
         join public.ai_image_generations g on g.id = o.generation_id
         join public.creative_slots s on s.id = g.slot_id
        where s.request_id = $1 order by o.created_at`,
        [requestId],
      ),
      pool.query<{
        id: string;
        slot_id: string;
        source_kind: string;
        media_asset_id: string;
        generation_output_id: string | null;
        status: string;
        resolved_at: string | null;
        asset_review_state: string;
        asset_file_url: string | null;
      }>(
        `select r.id, r.slot_id, r.source_kind, r.media_asset_id, r.generation_output_id, r.status, r.resolved_at,
              a.review_state as asset_review_state, a.file_url as asset_file_url
         from public.creative_slot_resolutions r
         join public.creative_slots s on s.id = r.slot_id
         join public.media_assets a on a.id = r.media_asset_id
        where s.request_id = $1 order by r.created_at`,
        [requestId],
      ),
      pool.query<{
        id: string;
        generation_id: string;
        reserved_minor: string;
        actual_minor: string | null;
        status: string;
        currency: string;
      }>(
        `select r.id, r.generation_id, r.reserved_minor::text, r.actual_minor::text, r.status, b.currency
         from public.creative_budget_reservations r
         join public.creative_budget_periods b on b.id = r.budget_period_id
         join public.ai_image_generations g on g.id = r.generation_id
         join public.creative_slots s on s.id = g.slot_id
        where s.request_id = $1 order by r.created_at`,
        [requestId],
      ),
    ]);
  const outputsByGeneration = new Map<string, Array<Record<string, unknown>>>();
  for (const output of outputs.rows) {
    const list = outputsByGeneration.get(output.generation_id) || [];
    list.push({
      ...output,
      preview_url:
        output.creative_state === "candidate"
          ? `/api/creative/outputs/${output.id}/preview`
          : null,
    });
    outputsByGeneration.set(output.generation_id, list);
  }
  const generationsBySlot = new Map<string, Array<Record<string, unknown>>>();
  for (const generation of generations.rows) {
    const list = generationsBySlot.get(generation.slot_id) || [];
    // A safe retry that is still queued belongs to the worker.  Do not expose
    // a manual retry action until its previous job is terminally failed.
    list.push({
      ...generation,
      retry_class:
        generation.job_status === "failed" ? generation.retry_class : null,
      outputs: outputsByGeneration.get(generation.id) || [],
    });
    generationsBySlot.set(generation.slot_id, list);
  }
  const resolutionsBySlot = new Map<string, Array<Record<string, unknown>>>();
  for (const resolution of resolutions.rows) {
    const list = resolutionsBySlot.get(resolution.slot_id) || [];
    list.push(resolution);
    resolutionsBySlot.set(resolution.slot_id, list);
  }
  return {
    ...root,
    slots: slots.rows.map((slot) => ({
      ...slot,
      generations: generationsBySlot.get(slot.id) || [],
      resolutions: resolutionsBySlot.get(slot.id) || [],
    })),
    budget_events: budgetEvents.rows,
  };
}

export async function acknowledgeCreativePlacement(
  requestId: string,
  actorId: string,
  publishedAt?: string,
) {
  if (!isUuid(requestId))
    throw new ApiError(400, "INVALID_ID", "Creative request không hợp lệ.");
  const client = await requireNativeDatabase().connect();
  try {
    await client.query("begin");
    const request = await client.query<{
      channel_version_id: string;
      external_article_id: string | null;
      external_revision: string | null;
    }>(
      `select channel_version_id, external_article_id, external_revision from public.creative_requests where id = $1 for update`,
      [requestId],
    );
    if (!request.rows[0]) throw notFound("Không tìm thấy creative request.");
    const current = await client.query<{ exists: boolean }>(
      `select exists(
         select 1 from public.creative_article_heads
          where external_source = (select external_source from public.creative_requests where id = $1)
            and external_article_id = (select external_article_id from public.creative_requests where id = $1)
            and current_request_id = $1
       ) as exists`,
      [requestId],
    );
    if (!current.rows[0]?.exists)
      throw new ApiError(
        409,
        "REVISION_SUPERSEDED",
        "Không thể publish acknowledgement cho revision cũ.",
      );
    const pending = await client.query<{ count: number }>(
      `select count(*)::int as count
         from public.creative_slots s
        where s.request_id = $1
          and not exists (
            select 1 from public.creative_slot_resolutions r
            join public.media_assets a on a.id = r.media_asset_id
            where r.slot_id = s.id and r.status = 'active' and a.review_state = 'approved' and a.deleted_at is null
          )`,
      [requestId],
    );
    if ((pending.rows[0]?.count || 0) > 0)
      throw new ApiError(
        409,
        "PLACEMENT_MANIFEST_INCOMPLETE",
        "Chỉ có thể xác nhận publish khi mọi slot đã resolved và approved.",
      );
    const published = publishedAt ? new Date(publishedAt) : new Date();
    if (Number.isNaN(published.getTime()))
      throw new ApiError(
        400,
        "INVALID_PUBLISHED_AT",
        "published_at không hợp lệ.",
      );
    if (published.getTime() > Date.now() + 5 * 60_000)
      throw new ApiError(
        400,
        "INVALID_PUBLISHED_AT",
        "published_at không được ở tương lai.",
      );
    await client.query(
      `insert into public.creative_placement_usages
        (media_asset_id, channel_version_id, request_id, slot_id, external_article_id, external_revision, published_at)
       select r.media_asset_id, $2, $1, s.id, $3, $4, $5
         from public.creative_slots s
         join public.creative_slot_resolutions r on r.slot_id = s.id and r.status = 'active'
       where s.request_id = $1
       on conflict (request_id, slot_id) do nothing`,
      [
        requestId,
        request.rows[0].channel_version_id,
        request.rows[0].external_article_id,
        request.rows[0].external_revision,
        published.toISOString(),
      ],
    );
    await client.query(
      `insert into public.creative_audit_events(request_id, event_type, actor_id, payload) values ($1, 'publish_acknowledged', $2, $3::jsonb)`,
      [
        requestId,
        actorId,
        JSON.stringify({ published_at: published.toISOString() }),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function extensionForMimeType(value: string | null) {
  if (value === "image/png") return "png";
  if (value === "image/jpeg") return "jpg";
  return "webp";
}

/**
 * R2 and PostgreSQL have no distributed transaction. The persisted saga is
 * intentionally created before copying, then finalized idempotently after the
 * canonical object has been verified by SHA-256.
 */
export async function promoteCreativeOutput(outputId: string, actorId: string) {
  if (!isUuid(outputId))
    throw new ApiError(400, "INVALID_ID", "Output không hợp lệ.");
  const pool = requireNativeDatabase();
  const setup = await pool.connect();
  let saga: {
    id: string;
    canonical_storage_key: string;
    expected_sha256: string;
    temp_storage_key: string;
    state: string;
  };
  try {
    await setup.query("begin");
    const output = await setup.query<{
      id: string;
      creative_state: string;
      expires_at: string;
      media_asset_id: string | null;
      temp_storage_key: string;
      temp_sha256: string;
      provenance: Record<string, unknown>;
    }>(
      `select id, creative_state, expires_at, media_asset_id, temp_storage_key, temp_sha256, provenance
         from public.ai_image_generation_outputs where id = $1 for update`,
      [outputId],
    );
    const row = output.rows[0];
    if (!row) throw notFound("Không tìm thấy candidate output.");
    if (row.media_asset_id) {
      await setup.query("commit");
      return { mediaAssetId: row.media_asset_id, replayed: true };
    }
    if (
      row.creative_state !== "candidate" ||
      new Date(row.expires_at).getTime() <= Date.now()
    ) {
      throw new ApiError(
        409,
        "CANDIDATE_NOT_PROMOTABLE",
        "Candidate đã hết hạn hoặc không còn có thể promote.",
      );
    }
    const mimeType =
      typeof row.provenance?.mime_type === "string"
        ? row.provenance.mime_type
        : "image/webp";
    const canonicalKey = `creative/canonical/${outputId}/${row.temp_sha256}.${extensionForMimeType(mimeType)}`;
    const sagaResult = await setup.query<typeof saga>(
      `insert into public.creative_storage_sagas(output_id, temp_storage_key, canonical_storage_key, expected_sha256)
       values ($1,$2,$3,$4)
       on conflict (output_id) do update set
         state = case
           when public.creative_storage_sagas.state = 'failed' then 'pending_copy'
           else public.creative_storage_sagas.state
         end,
         last_error = case
           when public.creative_storage_sagas.state = 'failed' then null
           else public.creative_storage_sagas.last_error
         end,
         updated_at = now()
       returning id, canonical_storage_key, expected_sha256, temp_storage_key, state`,
      [outputId, row.temp_storage_key, canonicalKey, row.temp_sha256],
    );
    saga = sagaResult.rows[0];
    await setup.query("commit");
  } catch (error) {
    await setup.query("rollback");
    throw error;
  } finally {
    setup.release();
  }

  try {
    if (saga.state === "pending_copy" || saga.state === "failed") {
      const source = await getR2ObjectByKey(saga.temp_storage_key);
      const sourceHash = createHash("sha256").update(source.body).digest("hex");
      if (sourceHash !== saga.expected_sha256)
        throw new ApiError(
          409,
          "CANDIDATE_HASH_MISMATCH",
          "Candidate object không khớp provenance hash.",
        );
      await putR2ObjectByKey(
        saga.canonical_storage_key,
        source.body,
        source.contentType || "image/webp",
      );
      await pool.query(
        `update public.creative_storage_sagas set state = 'copied', last_error = null, updated_at = now() where id = $1`,
        [saga.id],
      );
    }
    if (
      saga.state === "pending_copy" ||
      saga.state === "failed" ||
      saga.state === "copied"
    ) {
      const canonical = await getR2ObjectByKey(saga.canonical_storage_key);
      const canonicalHash = createHash("sha256")
        .update(canonical.body)
        .digest("hex");
      if (canonicalHash !== saga.expected_sha256)
        throw new ApiError(
          409,
          "CANONICAL_HASH_MISMATCH",
          "Canonical object không khớp expected hash.",
        );
      await pool.query(
        `update public.creative_storage_sagas set state = 'verified', last_error = null, updated_at = now() where id = $1`,
        [saga.id],
      );
    }
  } catch (error) {
    await pool
      .query(
        `update public.creative_storage_sagas set state = 'failed', last_error = $2, updated_at = now() where id = $1`,
        [
          saga.id,
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "storage failure",
        ],
      )
      .catch(() => undefined);
    throw error;
  }

  const finalize = await pool.connect();
  let mediaAssetId: string;
  try {
    await finalize.query("begin");
    const output = await finalize.query<{
      id: string;
      generation_id: string;
      creative_state: string;
      media_asset_id: string | null;
      provenance: Record<string, unknown>;
      slot_id: string;
      slot_key: string;
      request_id: string;
    }>(
      `select o.id, o.generation_id, o.creative_state, o.media_asset_id, o.provenance, g.slot_id, s.slot_key, s.request_id
         from public.ai_image_generation_outputs o
         join public.ai_image_generations g on g.id = o.generation_id
         join public.creative_slots s on s.id = g.slot_id
        where o.id = $1 for update`,
      [outputId],
    );
    const row = output.rows[0];
    if (!row) throw notFound("Không tìm thấy candidate output.");
    if (row.media_asset_id) {
      mediaAssetId = row.media_asset_id;
    } else {
      if (row.creative_state !== "candidate") {
        throw new ApiError(
          409,
          "CANDIDATE_NOT_PROMOTABLE",
          "Candidate không còn có thể finalize.",
        );
      }
      const sagaState = await finalize.query<{
        state: string;
        canonical_storage_key: string;
        expected_sha256: string;
      }>(
        `select state, canonical_storage_key, expected_sha256 from public.creative_storage_sagas where output_id = $1 for update`,
        [outputId],
      );
      if (
        !sagaState.rows[0] ||
        !["verified", "db_finalized", "cleanup_pending", "complete"].includes(
          sagaState.rows[0].state,
        )
      ) {
        throw new ApiError(
          409,
          "PROMOTION_STORAGE_NOT_VERIFIED",
          "Canonical candidate chưa được verify.",
        );
      }
      const mimeType =
        typeof row.provenance?.mime_type === "string"
          ? row.provenance.mime_type
          : "image/webp";
      const protectedAssetUrl = `/api/r2-proxy?key=${encodeURIComponent(sagaState.rows[0].canonical_storage_key)}`;
      const asset = await finalize.query<{ id: string }>(
        `insert into public.media_assets
          (title, file_url, thumbnail_url, storage_path, thumbnail_path, media_type, permission, review_state,
           ai_flags, dimensions, origin_info, content_hash, ingest_status, created_by)
         values ($1,$2,$2,$3,$3,'render','internal','pending',
                 jsonb_build_object('is_ai', true, 'is_internal', false),
                 coalesce($4::jsonb, '{}'::jsonb),
                 jsonb_build_object('source', 'AI Creative Pipeline', 'creative_output_id', $5::text, 'creative_request_id', $6::text, 'mime_type', $7),
                 $8, 'ready', $9)
         returning id`,
        [
          `AI Creative — ${row.slot_key}`,
          protectedAssetUrl,
          sagaState.rows[0].canonical_storage_key,
          JSON.stringify(
            (row.provenance?.dimensions as
              Record<string, unknown> | undefined) || {},
          ),
          outputId,
          row.request_id,
          mimeType,
          sagaState.rows[0].expected_sha256,
          actorId,
        ],
      );
      mediaAssetId = asset.rows[0].id;
      await finalize.query(
        `insert into public.review_queue(media_asset_id, status) values ($1, 'pending')`,
        [mediaAssetId],
      );
      await finalize.query(
        `update public.ai_image_generation_outputs
            set creative_state = 'promoted', review_state = 'pending', media_asset_id = $2,
                canonical_storage_key = $3, canonical_sha256 = $4, updated_at = now()
          where id = $1`,
        [
          outputId,
          mediaAssetId,
          sagaState.rows[0].canonical_storage_key,
          sagaState.rows[0].expected_sha256,
        ],
      );
      await finalize.query(
        `update public.creative_slot_resolutions set status = 'superseded', updated_at = now() where slot_id = $1 and status = 'proposed'`,
        [row.slot_id],
      );
      await finalize.query(
        `insert into public.creative_slot_resolutions(slot_id, source_kind, media_asset_id, generation_output_id, status, resolved_by)
         values ($1, 'ai', $2, $3, 'proposed', $4)`,
        [row.slot_id, mediaAssetId, outputId, actorId],
      );
      await finalize.query(
        `update public.creative_storage_sagas set state = 'db_finalized', updated_at = now() where output_id = $1`,
        [outputId],
      );
      await finalize.query(
        `select public.recompute_creative_slots(array[$1::uuid])`,
        [row.slot_id],
      );
      await finalize.query(
        `insert into public.creative_audit_events(request_id, generation_id, output_id, event_type, actor_id) values ($1,$2,$3,'candidate_promoted',$4)`,
        [row.request_id, row.generation_id, outputId, actorId],
      );
    }
    await finalize.query("commit");
  } catch (error) {
    await finalize.query("rollback");
    throw error;
  } finally {
    finalize.release();
  }

  try {
    await deleteR2ObjectByKey(saga.temp_storage_key);
    await pool.query(
      `update public.creative_storage_sagas set state = 'complete', completed_at = now(), updated_at = now() where id = $1`,
      [saga.id],
    );
  } catch (error) {
    await pool
      .query(
        `update public.creative_storage_sagas set state = 'cleanup_pending', last_error = $2, updated_at = now() where id = $1`,
        [
          saga.id,
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "temporary cleanup failure",
        ],
      )
      .catch(() => undefined);
  }
  return { mediaAssetId, replayed: false };
}
