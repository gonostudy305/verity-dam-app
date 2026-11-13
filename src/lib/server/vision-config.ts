import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { VisionDetail } from '@/types/media';

import { ApiError } from './http';
import { requireNativeDatabase } from './native-db';

const CONFIG_TABLE = 'verity_ai_vision_config';
const CONFIG_KEY = 'default';
const ENCRYPTION_VERSION = 1;
const AAD = Buffer.from('verity:ai-vision-config:v1', 'utf8');


const DEFAULT_CONFIG = {
  baseUrl: 'https://api.example.com/v1',
  model: 'cx/gpt-6-luna',
  detail: 'high' as VisionDetail,
  maxTokens: 1000,
  systemPrompt:
    'Vision creates Vietnamese captions and open metadata only. Never infer, return, rank, or mention SKU/product codes; SKU matching is a separate embedding-reference system.',
};

type ConfigRow = {
  config_key: string;
  provider: string;
  base_url: string;
  model: string;
  image_detail: VisionDetail;
  max_tokens: number;
  system_prompt: string;
  api_key_ciphertext: string;
  api_key_nonce: string;
  api_key_auth_tag: string;
  encryption_version: number;
  active: boolean;
  updated_at: string;
};

export type SharedVisionConfig = {
  baseUrl: string;
  model: string;
  detail: VisionDetail;
  maxTokens: number;
  systemPrompt: string;
  configured: boolean;
  updatedAt: string | null;
};

export type SharedVisionConfigInput = Omit<SharedVisionConfig, 'configured' | 'updatedAt'> & {
  apiKey?: string;
};

export type VisionRuntimeConfig = Omit<SharedVisionConfig, 'configured' | 'updatedAt'> & {
  apiKey: string;
};

type EncryptedSecret = {
  ciphertext: string;
  nonce: string;
  authTag: string;
};

function configStoreUnavailable() {
  return new ApiError(
    503,
    'VISION_CONFIG_STORE_UNAVAILABLE',
    'The shared AI configuration store is not ready. Run the native PostgreSQL migration and verify server secrets.'
  );
}

function assertValidVisionBaseUrl(baseUrl: string) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision base URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision base URL must be HTTPS without credentials or query strings.');
  }
  return url;
}

function getMasterKey() {
  const encoded = (process.env.VERITY_VISION_CONFIG_MASTER_KEY || '').trim();
  // Keep the exact decoding contract in sync with Python's
  // base64.b64decode(..., validate=True).
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw configStoreUnavailable();
  }
  const key = Buffer.from(encoded, 'base64');
  if (!encoded || key.length !== 32 || key.toString('base64') !== encoded) throw configStoreUnavailable();
  return key;
}

function encryptApiKey(apiKey: string): EncryptedSecret {
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

function decryptApiKey(row: ConfigRow) {
  if (row.encryption_version !== ENCRYPTION_VERSION) throw configStoreUnavailable();
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      getMasterKey(),
      Buffer.from(row.api_key_nonce, 'base64'),
      { authTagLength: 16 }
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(row.api_key_auth_tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.api_key_ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8').trim();
    if (!plaintext) throw new Error('Decrypted API key was blank.');
    return plaintext;
  } catch {
    throw configStoreUnavailable();
  }
}

function asView(row: ConfigRow | null): SharedVisionConfig {
  if (!row || !row.active) return { ...DEFAULT_CONFIG, configured: false, updatedAt: null };
  return {
    baseUrl: row.base_url,
    model: row.model,
    detail: row.image_detail,
    maxTokens: row.max_tokens,
    systemPrompt: row.system_prompt,
    configured: true,
    updatedAt: row.updated_at,
  };
}

function validateInput(value: unknown): SharedVisionConfigInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision configuration is invalid.');
  }
  const source = value as Record<string, unknown>;
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim().replace(/\/$/, '') : '';
  const url = assertValidVisionBaseUrl(baseUrl);
  const model = typeof source.model === 'string' ? source.model.trim() : '';
  if (!model || model.length > 200) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision model is invalid.');
  }
  const detail = source.detail;
  if (detail !== 'auto' && detail !== 'low' && detail !== 'high') {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision image detail is invalid.');
  }
  const maxTokens = source.maxTokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) < 256 || (maxTokens as number) > 4096) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision max tokens must be between 256 and 4096.');
  }
  const systemPrompt = typeof source.systemPrompt === 'string' ? source.systemPrompt.trim() : '';
  if (!systemPrompt || systemPrompt.length > 8_000) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision system prompt must be 1 to 8,000 characters.');
  }
  const rawApiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  if (rawApiKey && (rawApiKey.length < 8 || rawApiKey.length > 2_000)) {
    throw new ApiError(400, 'INVALID_VISION_CONFIG', 'Vision API key is invalid.');
  }
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    model,
    detail,
    maxTokens: maxTokens as number,
    systemPrompt,
    ...(rawApiKey ? { apiKey: rawApiKey } : {}),
  };
}

async function getRow(): Promise<ConfigRow | null> {
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(`select * from public.${CONFIG_TABLE} where config_key = $1 limit 1`, [CONFIG_KEY]);
    return result.rows[0] || null;
  } catch {
    throw configStoreUnavailable();
  }
}

export async function getSharedVisionConfig(): Promise<SharedVisionConfig> {
  return asView(await getRow());
}

export async function getSharedVisionRuntimeConfig(): Promise<VisionRuntimeConfig> {
  const row = await getRow();
  if (!row || !row.active) throw configStoreUnavailable();
  assertValidVisionBaseUrl(row.base_url);
  return {
    baseUrl: row.base_url,
    model: row.model,
    detail: row.image_detail,
    maxTokens: row.max_tokens,
    systemPrompt: row.system_prompt,
    apiKey: decryptApiKey(row),
  };
}

export async function saveSharedVisionConfig(value: unknown, updatedBy?: string): Promise<SharedVisionConfig> {
  const input = validateInput(value);
  const existing = await getRow();

  let ciphertext: string;
  let nonce: string;
  let authTag: string;
  let encryptionVersion: number;

  if (input.apiKey) {
    const encrypted = encryptApiKey(input.apiKey);
    ciphertext = encrypted.ciphertext;
    nonce = encrypted.nonce;
    authTag = encrypted.authTag;
    encryptionVersion = ENCRYPTION_VERSION;
  } else if (existing && existing.active && existing.api_key_ciphertext) {
    // If the base URL host changed without a new key, require a key for the new host
    try {
      const existingHost = new URL(existing.base_url).hostname;
      const newHost = new URL(input.baseUrl).hostname;
      if (existingHost !== newHost) {
        throw new ApiError(400, 'VISION_API_KEY_REQUIRED', 'Vui lòng nhập API key khi thay đổi Base URL sang máy chủ mới.');
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
    }

    ciphertext = existing.api_key_ciphertext;
    nonce = existing.api_key_nonce;
    authTag = existing.api_key_auth_tag;
    encryptionVersion = existing.encryption_version;
  } else {
    throw new ApiError(400, 'VISION_API_KEY_REQUIRED', 'Nhập API key để lưu cấu hình Vision dùng chung lần đầu.');
  }
  try {
    const result = await requireNativeDatabase().query<ConfigRow>(
      `insert into public.${CONFIG_TABLE}
       (config_key, provider, base_url, model, image_detail, max_tokens, system_prompt,
        api_key_ciphertext, api_key_nonce, api_key_auth_tag, encryption_version, active, updated_by)
       values ($1,'openai-compatible',$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)
       on conflict (config_key) do update set base_url=excluded.base_url, model=excluded.model,
        image_detail=excluded.image_detail, max_tokens=excluded.max_tokens, system_prompt=excluded.system_prompt,
        api_key_ciphertext=excluded.api_key_ciphertext, api_key_nonce=excluded.api_key_nonce,
        api_key_auth_tag=excluded.api_key_auth_tag, encryption_version=excluded.encryption_version,
        active=true, updated_by=excluded.updated_by, updated_at=now() returning *`,
      [CONFIG_KEY, input.baseUrl, input.model, input.detail, input.maxTokens, input.systemPrompt,
        ciphertext, nonce, authTag, encryptionVersion, updatedBy || null]
    );
    return asView(result.rows[0] || null);
  } catch {
    throw configStoreUnavailable();
  }
}

export const visionConfigDefaults = DEFAULT_CONFIG;
