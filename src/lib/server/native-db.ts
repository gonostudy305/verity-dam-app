import { Pool, type QueryResultRow } from 'pg';

import { ApiError } from './http';

const DEV_DATABASE_URL = 'postgresql://verity:verity_dev_only@127.0.0.1:5433/verity_media';
const BUILD_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/verity_media';

declare global {
  // eslint-disable-next-line no-var
  var __verityNativePool: Pool | undefined;
}

function configuredDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  if (value) return value;
  if (process.env.NODE_ENV === 'development' && process.env.VERITY_ALLOW_DEV_DATABASE_FALLBACK === 'true') {
    return DEV_DATABASE_URL;
  }
  return BUILD_DATABASE_URL;
}

function validateDatabaseUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ApiError(503, 'DATABASE_NOT_CONFIGURED', 'DATABASE_URL khÃ´ng há»£p lá»‡.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new ApiError(503, 'DATABASE_NOT_CONFIGURED', 'DATABASE_URL khÃ´ng há»£p lá»‡.');
  }
  const localHosts = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'verity_media_db']);
  const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
  if (!localHosts.has(parsed.hostname.toLowerCase()) && !['require', 'verify-ca', 'verify-full'].includes(sslMode || '')) {
    throw new ApiError(503, 'DATABASE_TLS_REQUIRED', 'DATABASE_URL pháº£i báº­t sslmode=require hoáº·c verify-full khi káº¿t ná»‘i qua máº¡ng.');
  }
}

export function getNativePool() {
  if (!globalThis.__verityNativePool) {
    globalThis.__verityNativePool = new Pool({
      connectionString: configuredDatabaseUrl(),
      max: Number(process.env.VERITY_DB_MAX_CONNECTIONS || 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'verity-media-next',
    });
  }
  return globalThis.__verityNativePool;
}

export async function nativeQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  return getNativePool().query<T>(text, values);
}

export function requireNativeDatabase() {
  const value = process.env.DATABASE_URL?.trim();
  const localDev = process.env.NODE_ENV === 'development' && process.env.VERITY_ALLOW_DEV_DATABASE_FALLBACK === 'true';
  if (!localDev && !value) {
    throw new ApiError(503, 'DATABASE_NOT_CONFIGURED', 'PostgreSQL chưa được cấu hình trên máy chủ.');
  }
  validateDatabaseUrl(value || DEV_DATABASE_URL);
  return getNativePool();
}
