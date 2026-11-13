import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ApiError } from './http';
import { requireNativeDatabase } from './native-db';

const CONFIG_TABLE = 'verity_ai_embedding_config';
const CONFIG_KEY = 'default';
const ENCRYPTION_VERSION = 1;
const AAD = Buffer.from('verity:ai-embedding-config:v1', 'utf8');

export const SUPPORTED_PROVIDERS = ['9router', 'gemini'] as const;
export type EmbeddingProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const PROVIDER_DEFAULTS: Record<
  EmbeddingProvider,
  { baseUrl: string; model: string; embeddingVersion: string; embeddingDimension: number }
> = {
  '9router': {
    baseUrl: 'https://api.example.com/v1',
    model: 'jina-ai/jina-clip-v2',
    embeddingVersion: 'jina-clip-v2-v1',
    embeddingDimension: 512,
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'text-embedding-004',
    embeddingVersion: 'text-embedding-004',
    embeddingDimension: 768,
  },
};

// Keep backward-compatible default
export const SHARED_EMBEDDING_DEFAULTS = PROVIDER_DEFAULTS['9router'];

type ConfigRow = {
  config_key: string;
  provider: string;
  base_url: string;
  model: string;
  embedding_version: string;
  embedding_dimension: number;
  api_key_ciphertext: string;
  api_key_nonce: string;
  api_key_auth_tag: string;
  encryption_version: number;
  active: boolean;
  updated_at: string;
  // Fallback columns (nullable)
  fallback_provider: string | null;
  fallback_base_url: string | null;
  fallback_model: string | null;
  fallback_api_key_ciphertext: string | null;
  fallback_api_key_nonce: string | null;
  fallback_api_key_auth_tag: string | null;
};

export type SharedEmbeddingConfig = {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  embeddingVersion: string;
  embeddingDimension: number;
  configured: boolean;
  updatedAt: string | null;
  fallback: {
    enabled: boolean;
    provider: EmbeddingProvider | null;
    baseUrl: string | null;
    model: string | null;
    configured: boolean;
  };
};

function configStoreUnavailable() {
  return new ApiError(
    503,
    'EMBEDDING_CONFIG_STORE_UNAVAILABLE',
    'The shared Embedding configuration store is not ready. Run the native PostgreSQL migration and verify server secrets.'
  );
}

function getMasterKey() {
  const encoded = (process.env.VERITY_VISION_CONFIG_MASTER_KEY || '').trim();
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw configStoreUnavailable();
  }
  const key = Buffer.from(encoded, 'base64');
  if (!encoded || key.length !== 32 || key.toString('base64') !== encoded) throw configStoreUnavailable();
  return key;
}

function encryptApiKey(apiKey: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(), nonce, { authTagLength: 16 });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function asView(row: ConfigRow | null): SharedEmbeddingConfig {
  if (!row || !row.active) {
    return {
      provider: '9router',
      ...SHARED_EMBEDDING_DEFAULTS,
      configured: false,
      updatedAt: null,
      fallback: { enabled: false, provider: null, baseUrl: null, model: null, configured: false },
    };
  }
  const provider = (SUPPORTED_PROVIDERS.includes(row.provider as EmbeddingProvider)
    ? row.provider
    : '9router') as EmbeddingProvider;
  const fallbackProvider = row.fallback_provider
    ? ((SUPPORTED_PROVIDERS.includes(row.fallback_provider as EmbeddingProvider)
        ? row.fallback_provider
        : null) as EmbeddingProvider | null)
    : null;
  return {
    provider,
    baseUrl: row.base_url,
    model: row.model,
    embeddingVersion: row.embedding_version,
    embeddingDimension: row.embedding_dimension,
    configured: true,
    updatedAt: row.updated_at,
    fallback: {
      enabled: Boolean(fallbackProvider && row.fallback_api_key_ciphertext),
      provider: fallbackProvider,
      baseUrl: row.fallback_base_url,
      model: row.fallback_model,
      configured: Boolean(fallbackProvider && row.fallback_api_key_ciphertext),
    },
  };
}

function validateApiKey(value: unknown, field: string) {
  const apiKey = typeof value === 'string' ? value.trim() : '';
  if (apiKey.length < 8 || apiKey.length > 2_000) {
    throw new ApiError(400, 'EMBEDDING_API_KEY_REQUIRED', `Enter a valid ${field} API key.`);
  }
  return apiKey;
}

async function getRow(): Promise<ConfigRow | null> {
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(`select * from public.${CONFIG_TABLE} where config_key = $1 limit 1`, [CONFIG_KEY]);
    return result.rows[0] || null;
  } catch (error) {
    throw configStoreUnavailable();
  }
}

export async function getSharedEmbeddingConfig(): Promise<SharedEmbeddingConfig> {
  return asView(await getRow());
}

export async function saveSharedEmbeddingConfig(value: unknown, updatedBy?: string): Promise<SharedEmbeddingConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_EMBEDDING_CONFIG', 'Embedding configuration is invalid.');
  }
  const body = value as Record<string, unknown>;

  // Validate primary provider
  const provider: EmbeddingProvider = SUPPORTED_PROVIDERS.includes(body.provider as EmbeddingProvider)
    ? (body.provider as EmbeddingProvider)
    : '9router';
  const defaults = PROVIDER_DEFAULTS[provider];
  const apiKey = validateApiKey(body.apiKey, `${provider} primary`);
  const encrypted = encryptApiKey(apiKey);

  // Validate optional fallback
  let fallbackFields: Record<string, unknown> = {
    fallback_provider: null,
    fallback_base_url: null,
    fallback_model: null,
    fallback_api_key_ciphertext: null,
    fallback_api_key_nonce: null,
    fallback_api_key_auth_tag: null,
  };

  const fallbackProvider = body.fallbackProvider;
  const fallbackApiKey = body.fallbackApiKey;
  if (
    typeof fallbackProvider === 'string' &&
    SUPPORTED_PROVIDERS.includes(fallbackProvider as EmbeddingProvider) &&
    fallbackProvider !== provider &&
    typeof fallbackApiKey === 'string' &&
    fallbackApiKey.trim().length >= 8
  ) {
    const encryptedFallback = encryptApiKey(fallbackApiKey.trim());
    const fallbackDefaults = PROVIDER_DEFAULTS[fallbackProvider as EmbeddingProvider];
    fallbackFields = {
      fallback_provider: fallbackProvider,
      fallback_base_url: typeof body.fallbackBaseUrl === 'string' && body.fallbackBaseUrl.trim()
        ? body.fallbackBaseUrl.trim()
        : fallbackDefaults.baseUrl,
      fallback_model: typeof body.fallbackModel === 'string' && body.fallbackModel.trim()
        ? body.fallbackModel.trim()
        : fallbackDefaults.model,
      fallback_api_key_ciphertext: encryptedFallback.ciphertext,
      fallback_api_key_nonce: encryptedFallback.nonce,
      fallback_api_key_auth_tag: encryptedFallback.authTag,
    };
  }

  try {
    const result = await requireNativeDatabase().query<ConfigRow>(
      `insert into public.${CONFIG_TABLE}
       (config_key, provider, base_url, model, embedding_version, embedding_dimension,
        api_key_ciphertext, api_key_nonce, api_key_auth_tag, encryption_version, active,
        updated_by, fallback_provider, fallback_base_url, fallback_model,
        fallback_api_key_ciphertext, fallback_api_key_nonce, fallback_api_key_auth_tag)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12,$13,$14,$15,$16,$17)
       on conflict (config_key) do update set provider=excluded.provider, base_url=excluded.base_url,
        model=excluded.model, embedding_version=excluded.embedding_version, embedding_dimension=excluded.embedding_dimension,
        api_key_ciphertext=excluded.api_key_ciphertext, api_key_nonce=excluded.api_key_nonce, api_key_auth_tag=excluded.api_key_auth_tag,
        encryption_version=excluded.encryption_version, active=true, updated_by=excluded.updated_by,
        fallback_provider=excluded.fallback_provider, fallback_base_url=excluded.fallback_base_url,
        fallback_model=excluded.fallback_model, fallback_api_key_ciphertext=excluded.fallback_api_key_ciphertext,
        fallback_api_key_nonce=excluded.fallback_api_key_nonce, fallback_api_key_auth_tag=excluded.fallback_api_key_auth_tag,
        updated_at=now() returning *`, [
      CONFIG_KEY,
      provider, defaults.baseUrl, defaults.model, defaults.embeddingVersion, defaults.embeddingDimension,
      encrypted.ciphertext, encrypted.nonce, encrypted.authTag, ENCRYPTION_VERSION, updatedBy || null,
      fallbackFields.fallback_provider, fallbackFields.fallback_base_url, fallbackFields.fallback_model,
      fallbackFields.fallback_api_key_ciphertext, fallbackFields.fallback_api_key_nonce, fallbackFields.fallback_api_key_auth_tag,
    ]);
    return asView(result.rows[0] || null);
  } catch (error) {
    throw configStoreUnavailable();
  }
}
