import { createCipheriv, randomBytes } from "node:crypto";

import { isCreativeProviderModel } from "@/lib/creative-generation";

import { ApiError } from "./http";
import { requireNativeDatabase } from "./native-db";

const CONFIG_TABLE = "verity_ai_creative_config";
const CONFIG_KEY = "default";
const ENCRYPTION_VERSION = 1;
const AAD = Buffer.from("verity:ai-creative-config:v1", "utf8");

export const CREATIVE_PROVIDER_DEFAULTS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2.5-flare-2026-09-08",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.1-flash-image",
  },
} as const;

export type CreativeProvider = keyof typeof CREATIVE_PROVIDER_DEFAULTS;

type ConfigRow = {
  config_key: string;
  openai_base_url: string;
  openai_model: string;
  openai_api_key_ciphertext: string | null;
  openai_api_key_nonce: string | null;
  openai_api_key_auth_tag: string | null;
  gemini_base_url: string;
  gemini_model: string;
  gemini_api_key_ciphertext: string | null;
  gemini_api_key_nonce: string | null;
  gemini_api_key_auth_tag: string | null;
  encryption_version: number;
  active: boolean;
  updated_at: string;
};

export type CreativeProviderView = {
  baseUrl: string;
  model: string;
  configured: boolean;
};

export type SharedCreativeConfig = {
  openai: CreativeProviderView;
  gemini: CreativeProviderView;
  configured: boolean;
  updatedAt: string | null;
};

type ProviderInput = {
  baseUrl?: unknown;
  model?: unknown;
  apiKey?: unknown;
};

function configStoreUnavailable() {
  return new ApiError(
    503,
    "CREATIVE_CONFIG_STORE_UNAVAILABLE",
    "Creative provider settings are not ready. Apply native migrations and verify the shared config master key.",
  );
}

function getMasterKey() {
  const encoded = (process.env.VERITY_VISION_CONFIG_MASTER_KEY || "").trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    throw configStoreUnavailable();
  }
  const key = Buffer.from(encoded, "base64");
  if (!encoded || key.length !== 32 || key.toString("base64") !== encoded)
    throw configStoreUnavailable();
  return key;
}

function encryptApiKey(apiKey: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function assertBaseUrl(value: unknown, field: string, fallback: string) {
  const source =
    typeof value === "string" && value.trim()
      ? value.trim().replace(/\/$/, "")
      : fallback;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIG",
      `${field} base URL is invalid.`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIG",
      `${field} base URL must be HTTPS without credentials or query strings.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

function assertModel(
  value: unknown,
  provider: CreativeProvider,
  field: string,
  fallback: string,
) {
  const model =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!isCreativeProviderModel(provider, model)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIG",
      `${field} model must be a pinned AI Creative model.`,
    );
  }
  return model;
}

function optionalApiKey(value: unknown, field: string) {
  const key = typeof value === "string" ? value.trim() : "";
  if (key && (key.length < 8 || key.length > 2_000)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIG",
      `${field} API key is invalid.`,
    );
  }
  return key;
}

function configured(
  row: ConfigRow | null,
  provider: CreativeProvider,
): boolean {
  if (!row?.active) return false;
  return provider === "openai"
    ? Boolean(row.openai_api_key_ciphertext)
    : Boolean(row.gemini_api_key_ciphertext);
}

function asView(row: ConfigRow | null): SharedCreativeConfig {
  return {
    openai: {
      baseUrl:
        row?.openai_base_url || CREATIVE_PROVIDER_DEFAULTS.openai.baseUrl,
      model: row?.openai_model || CREATIVE_PROVIDER_DEFAULTS.openai.model,
      configured: configured(row, "openai"),
    },
    gemini: {
      baseUrl:
        row?.gemini_base_url || CREATIVE_PROVIDER_DEFAULTS.gemini.baseUrl,
      model: row?.gemini_model || CREATIVE_PROVIDER_DEFAULTS.gemini.model,
      configured: configured(row, "gemini"),
    },
    configured: configured(row, "openai") || configured(row, "gemini"),
    updatedAt: row?.active ? row.updated_at : null,
  };
}

async function getRow(): Promise<ConfigRow | null> {
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(
      `select * from public.${CONFIG_TABLE} where config_key = $1 limit 1`,
      [CONFIG_KEY],
    );
    return result.rows[0] || null;
  } catch {
    throw configStoreUnavailable();
  }
}

export async function getSharedCreativeConfig(): Promise<SharedCreativeConfig> {
  return asView(await getRow());
}

function existingSecret(row: ConfigRow | null, provider: CreativeProvider) {
  if (!row) return { ciphertext: null, nonce: null, authTag: null };
  return provider === "openai"
    ? {
        ciphertext: row.openai_api_key_ciphertext,
        nonce: row.openai_api_key_nonce,
        authTag: row.openai_api_key_auth_tag,
      }
    : {
        ciphertext: row.gemini_api_key_ciphertext,
        nonce: row.gemini_api_key_nonce,
        authTag: row.gemini_api_key_auth_tag,
      };
}

function secretFor(
  row: ConfigRow | null,
  provider: CreativeProvider,
  value: unknown,
) {
  const apiKey = optionalApiKey(value, provider);
  if (apiKey) return encryptApiKey(apiKey);
  const previous = existingSecret(row, provider);
  if (previous.ciphertext && previous.nonce && previous.authTag)
    return previous;
  return { ciphertext: null, nonce: null, authTag: null };
}

export async function saveSharedCreativeConfig(
  value: unknown,
  updatedBy?: string,
): Promise<SharedCreativeConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      400,
      "INVALID_CREATIVE_CONFIG",
      "Creative provider configuration is invalid.",
    );
  }
  const source = value as Record<string, unknown>;
  const openai = (
    source.openai && typeof source.openai === "object" ? source.openai : {}
  ) as ProviderInput;
  const gemini = (
    source.gemini && typeof source.gemini === "object" ? source.gemini : {}
  ) as ProviderInput;
  const openaiBaseUrl = assertBaseUrl(
    openai.baseUrl,
    "OpenAI",
    CREATIVE_PROVIDER_DEFAULTS.openai.baseUrl,
  );
  const geminiBaseUrl = assertBaseUrl(
    gemini.baseUrl,
    "Gemini",
    CREATIVE_PROVIDER_DEFAULTS.gemini.baseUrl,
  );
  const openaiModel = assertModel(
    openai.model,
    "openai",
    "OpenAI",
    CREATIVE_PROVIDER_DEFAULTS.openai.model,
  );
  const geminiModel = assertModel(
    gemini.model,
    "gemini",
    "Gemini",
    CREATIVE_PROVIDER_DEFAULTS.gemini.model,
  );
  const row = await getRow();
  const openaiSecret = secretFor(row, "openai", openai.apiKey);
  const geminiSecret = secretFor(row, "gemini", gemini.apiKey);
  if (!openaiSecret.ciphertext && !geminiSecret.ciphertext) {
    throw new ApiError(
      400,
      "CREATIVE_API_KEY_REQUIRED",
      "Enter at least one OpenAI or Gemini API key before saving.",
    );
  }
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(
      `insert into public.${CONFIG_TABLE}
       (config_key, openai_base_url, openai_model, openai_api_key_ciphertext, openai_api_key_nonce, openai_api_key_auth_tag,
        gemini_base_url, gemini_model, gemini_api_key_ciphertext, gemini_api_key_nonce, gemini_api_key_auth_tag,
        encryption_version, active, updated_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13)
       on conflict (config_key) do update set
        openai_base_url=excluded.openai_base_url, openai_model=excluded.openai_model,
        openai_api_key_ciphertext=excluded.openai_api_key_ciphertext, openai_api_key_nonce=excluded.openai_api_key_nonce,
        openai_api_key_auth_tag=excluded.openai_api_key_auth_tag,
        gemini_base_url=excluded.gemini_base_url, gemini_model=excluded.gemini_model,
        gemini_api_key_ciphertext=excluded.gemini_api_key_ciphertext, gemini_api_key_nonce=excluded.gemini_api_key_nonce,
        gemini_api_key_auth_tag=excluded.gemini_api_key_auth_tag,
        encryption_version=excluded.encryption_version, active=true, updated_by=excluded.updated_by, updated_at=now()
       returning *`,
      [
        CONFIG_KEY,
        openaiBaseUrl,
        openaiModel,
        openaiSecret.ciphertext,
        openaiSecret.nonce,
        openaiSecret.authTag,
        geminiBaseUrl,
        geminiModel,
        geminiSecret.ciphertext,
        geminiSecret.nonce,
        geminiSecret.authTag,
        ENCRYPTION_VERSION,
        updatedBy || null,
      ],
    );
    return asView(result.rows[0] || null);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw configStoreUnavailable();
  }
}
