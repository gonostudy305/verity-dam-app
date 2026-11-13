import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { ApiError } from './http';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

function config() {
  const endpoint = process.env.R2_ENDPOINT?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Cloudflare R2 chưa được cấu hình.');
  }
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'R2_ENDPOINT không hợp lệ.'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'R2_ENDPOINT phải là HTTPS URL không kèm thông tin xác thực.');
  }
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

let client: S3Client | undefined;
function getClient() {
  const values = config();
  client ||= new S3Client({
    endpoint: values.endpoint,
    region: process.env.R2_REGION || 'auto',
    credentials: { accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey },
  });
  return { client, bucket: values.bucket };
}

export function isValidStorageKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  const cleanKey = key.trim();
  if (
    cleanKey.startsWith('/') ||
    cleanKey.includes('\0') ||
    cleanKey.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    return false;
  }
  return true;
}

function assertKeyScope(key: string, prefix: string) {
  if (!isValidStorageKey(key)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Đường dẫn R2 không hợp lệ.');
  }
  if (!key.startsWith(`${prefix.replace(/\/$/, '')}/`)) {
    throw new ApiError(403, 'STORAGE_SCOPE_DENIED', 'Đường dẫn R2 không thuộc tài khoản hiện tại.');
  }
}

export async function createR2UploadUrl(
  key: string,
  ownerId: string,
  contentType: string,
  contentLength: number
) {
  assertKeyScope(key, ownerId);
  if (!ALLOWED_MIME.has(contentType)) {
    throw new ApiError(400, 'INVALID_MEDIA_TYPE', 'Định dạng media không được hỗ trợ.');
  }
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw new ApiError(400, 'INVALID_MEDIA_SIZE', 'Dung lượng media không hợp lệ.');
  }
  const max = contentType.startsWith('video/') ? 200 * 1024 * 1024 : 50 * 1024 * 1024;
  if (contentLength > max) {
    throw new ApiError(400, 'MEDIA_TOO_LARGE', 'Media vượt quá giới hạn dung lượng.');
  }
  const values = getClient();
  const url = await getSignedUrl(
    values.client,
    new PutObjectCommand({
      Bucket: values.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: 900 }
  );
  return { url, key, method: 'PUT', headers: { 'Content-Type': contentType } };
}

export async function createR2DownloadUrl(key: string, scopePrefix: string) {
  assertKeyScope(key, scopePrefix);
  const values = getClient();
  return getSignedUrl(values.client, new GetObjectCommand({ Bucket: values.bucket, Key: key }), { expiresIn: 900 });
}

export async function headR2Object(key: string, ownerId: string) {
  assertKeyScope(key, ownerId);
  const values = getClient();
  try {
    const response = await values.client.send(new HeadObjectCommand({ Bucket: values.bucket, Key: key }));
    return {
      sizeBytes: Number(response.ContentLength || 0),
      contentType: (response.ContentType || '').toLowerCase(),
      etag: response.ETag || null,
    };
  } catch {
    throw new ApiError(409, 'UPLOAD_OBJECT_MISSING', 'Không tìm thấy object đã upload trên R2.');
  }
}

export async function putR2Object(
  key: string,
  ownerId: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<{ key: string; contentType: string; sizeBytes: number; etag: string | null }> {
  assertKeyScope(key, ownerId);
  if (!ALLOWED_MIME.has(contentType)) {
    throw new ApiError(400, 'INVALID_MEDIA_TYPE', 'Định dạng media không được hỗ trợ.');
  }
  const values = getClient();
  const res = await values.client.send(
    new PutObjectCommand({
      Bucket: values.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    })
  );
  return {
    key,
    contentType,
    sizeBytes: body.length,
    etag: res.ETag || null,
  };
}

export async function putR2ObjectByKey(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<{ key: string; contentType: string; sizeBytes: number; etag: string | null }> {
  if (!isValidStorageKey(key)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Đường dẫn R2 không hợp lệ.');
  }
  if (!ALLOWED_MIME.has(contentType)) {
    throw new ApiError(400, 'INVALID_MEDIA_TYPE', 'Định dạng media không được hỗ trợ.');
  }
  const values = getClient();
  const res = await values.client.send(
    new PutObjectCommand({
      Bucket: values.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
    })
  );
  return {
    key,
    contentType,
    sizeBytes: body.length,
    etag: res.ETag || null,
  };
}

/** Upload a server-created archive without buffering the complete ZIP in the
 * Next.js heap. The key is generated by the archive processor, never accepted
 * from the browser. */
export async function putR2FileByKey(
  key: string,
  filePath: string,
  contentType = 'application/zip'
): Promise<{ key: string; contentType: string; sizeBytes: number; etag: string | null }> {
  if (!isValidStorageKey(key)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Đường dẫn R2 không hợp lệ.');
  }
  const file = await stat(filePath);
  if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new ApiError(400, 'INVALID_ARCHIVE_FILE', 'Archive không hợp lệ.');
  }
  const values = getClient();
  const res = await values.client.send(
    new PutObjectCommand({
      Bucket: values.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentType: contentType,
      ContentLength: file.size,
    })
  );
  return { key, contentType, sizeBytes: file.size, etag: res.ETag || null };
}

export async function getR2ObjectByKey(
  key: string
): Promise<{ body: Buffer; contentType: string; sizeBytes: number }> {
  if (!isValidStorageKey(key)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Đường dẫn R2 không hợp lệ.');
  }
  const values = getClient();
  const res = await values.client.send(new GetObjectCommand({ Bucket: values.bucket, Key: key }));
  const stream = res.Body;
  if (!stream) {
    throw new ApiError(404, 'STORAGE_OBJECT_NOT_FOUND', 'Object không tồn tại trên R2.');
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return {
    body: buffer,
    contentType: (res.ContentType || '').toLowerCase(),
    sizeBytes: Number(res.ContentLength || buffer.length),
  };
}

/** Deletes an object by its exact, already-persisted storage key (read from
 * the owning media_assets row) -- NOT a client-supplied key at request time,
 * so it intentionally skips assertKeyScope's per-uploader-prefix check (the
 * admin purging the asset is almost never the original uploader). Only ever
 * called by the Trash admin purge action, after the DB row is confirmed
 * soft-deleted. An object that is already gone is treated as success. */
export async function deleteR2ObjectByKey(key: string): Promise<void> {
  if (!isValidStorageKey(key)) {
    throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Đường dẫn R2 không hợp lệ.');
  }
  const values = getClient();
  try {
    await values.client.send(new DeleteObjectCommand({ Bucket: values.bucket, Key: key }));
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? (error as { name?: string }).name : undefined;
    if (name === 'NoSuchKey' || name === 'NotFound') return;
    throw error;
  }
}

export function getR2Bucket() {
  return config().bucket;
}

export function getR2PublicUrl(key: string): string {
  const baseUrl = (process.env.R2_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_R2_PUBLIC_URL || 'https://assets.verity.internal').replace(/\/$/, '');
  const cleanKey = key.replace(/^\/+/, '');
  return `${baseUrl}/${cleanKey}`;
}
