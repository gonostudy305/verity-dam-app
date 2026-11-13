import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { deleteR2ObjectByKey, getR2ObjectByKey, putR2FileByKey } from './r2';
import { requireNativeDatabase } from './native-db';

export const ARCHIVE_MAX_ASSETS = 25;
export const ARCHIVE_MAX_BYTES = 250 * 1024 * 1024;
export const ARCHIVE_EXPIRY_HOURS = 24;

type ArchiveManifestEntry = { id: string; name: string };
type ArchiveJob = {
  id: string;
  created_by: string;
  status: string;
  asset_manifest: unknown;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  expires_at: string;
};

class ArchiveCancelledError extends Error {}
class ArchiveLimitError extends Error {}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off('error', onError);
      reject(error);
    };
    stream.once('error', onError);
    stream.write(chunk, (error?: Error | null) => {
      if (settled) return;
      settled = true;
      stream.off('error', onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

function dosTimeDate() {
  // Fixed timestamps make the archive deterministic and avoid leaking the
  // server clock into a downloaded file's metadata.
  return { time: 0, date: 33 };
}

function localHeader(name: Buffer, data: Buffer): Buffer {
  const header = Buffer.alloc(30 + name.length);
  const { time, date } = dosTimeDate();
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  header.writeUInt16LE(0, 8); // stored, no compression dependency
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function centralHeader(name: Buffer, data: Buffer, offset: number): Buffer {
  const header = Buffer.alloc(46 + name.length);
  const { time, date } = dosTimeDate();
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

async function writeZip(entries: Array<{ name: string; body: Buffer }>, filePath: string): Promise<number> {
  const stream = createWriteStream(filePath, { flags: 'w' });
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      if (name.length > 0xffff) throw new Error('ARCHIVE_FILENAME_TOO_LONG');
      const header = localHeader(name, entry.body);
      await writeChunk(stream, header);
      await writeChunk(stream, entry.body);
      central.push(centralHeader(name, entry.body, offset));
      offset += header.length + entry.body.length;
    }
    const centralOffset = offset;
    for (const chunk of central) {
      await writeChunk(stream, chunk);
      offset += chunk.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - centralOffset, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeChunk(stream, end);
    stream.end();
    await finished(stream);
    return offset + end.length;
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function safeFilenamePart(value: string): string {
  const withoutDiacritics = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const clean = withoutDiacritics
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return clean || 'asset';
}

function extensionForStoragePath(storagePath: string): string {
  const match = storagePath.match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
  const extension = match?.[1]?.toLowerCase();
  return extension && /^[a-z0-9]+$/.test(extension) ? `.${extension}` : '.bin';
}

export function deterministicArchiveFilename(index: number, title: string, storagePath: string): string {
  return `${String(index + 1).padStart(3, '0')}-${safeFilenamePart(title)}${extensionForStoragePath(storagePath)}`;
}

async function claimJob(jobId: string): Promise<ArchiveJob | null> {
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const result = await client.query<ArchiveJob>(
      `select id, created_by, status, asset_manifest, attempts, max_attempts, locked_at, expires_at
         from public.media_archive_jobs
        where id = $1
        for update`,
      [jobId]
    );
    const job = result.rows[0];
    if (!job) {
      await client.query('commit');
      return null;
    }
    if (new Date(job.expires_at).getTime() <= Date.now()) {
      await client.query(
        `update public.media_archive_jobs set status = 'expired', locked_at = null, updated_at = now()
          where id = $1 and status not in ('ready','expired','cancelled')`,
        [jobId]
      );
      await client.query('commit');
      return null;
    }
    if (job.status === 'cancelled' || job.status === 'expired' || job.status === 'ready') {
      await client.query('commit');
      return null;
    }
    const staleProcessing = job.status === 'processing'
      && job.attempts < job.max_attempts
      && (!job.locked_at || Date.now() - new Date(job.locked_at).getTime() > 10 * 60 * 1000);
    if (job.status !== 'queued' && !staleProcessing) {
      await client.query('commit');
      return null;
    }
    const updated = await client.query<ArchiveJob>(
      `update public.media_archive_jobs
          set status = 'processing', attempts = attempts + 1, locked_at = now(),
              processed_assets = 0, processed_bytes = 0, total_bytes = 0,
              archive_key = null, archive_size_bytes = null, error_message = null,
              updated_at = now()
        where id = $1
        returning id, created_by, status, asset_manifest, attempts, max_attempts, locked_at, expires_at`,
      [jobId]
    );
    await client.query('commit');
    return updated.rows[0] || null;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function assertNotCancelled(jobId: string): Promise<void> {
  const result = await requireNativeDatabase().query<{ status: string; expires_at: string }>(
    `select status, expires_at from public.media_archive_jobs where id = $1`,
    [jobId]
  );
  const job = result.rows[0];
  if (!job || job.status === 'cancelled') throw new ArchiveCancelledError('ARCHIVE_CANCELLED');
  if (new Date(job.expires_at).getTime() <= Date.now()) throw new ArchiveCancelledError('ARCHIVE_EXPIRED');
}

function manifestOf(value: unknown): ArchiveManifestEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ArchiveManifestEntry => (
    item && typeof item === 'object' && typeof (item as ArchiveManifestEntry).id === 'string' && typeof (item as ArchiveManifestEntry).name === 'string'
  ));
}

async function markFailed(jobId: string, message: string) {
  await requireNativeDatabase().query(
    `update public.media_archive_jobs
        set status = 'failed', error_message = $2, locked_at = null, updated_at = now()
      where id = $1 and status = 'processing'`,
    [jobId, message.slice(0, 500)]
  );
}

/**
 * Processes one archive in-process. The durable row is the source of truth;
 * status polling can safely call this again after a Node restart. ZIP writing
 * uses the store method (no compression) because originals are already
 * compressed media and this keeps the server free of a native ZIP dependency.
 */
export async function processMediaArchiveJob(jobId: string): Promise<void> {
  let job: ArchiveJob | null = null;
  let tempPath = '';
  try {
    job = await claimJob(jobId);
    if (!job) return;
    const manifest = manifestOf(job.asset_manifest);
    if (manifest.length === 0 || manifest.length > ARCHIVE_MAX_ASSETS) throw new Error('ARCHIVE_MANIFEST_INVALID');
    const entries: Array<{ name: string; body: Buffer }> = [];
    let totalBytes = 0;

    for (let index = 0; index < manifest.length; index += 1) {
      await assertNotCancelled(jobId);
      const item = manifest[index];
      const asset = await requireNativeDatabase().query<{ storage_path: string | null }>(
        `select storage_path from public.media_assets
          where id = $1 and deleted_at is null and review_state = 'approved'`,
        [item.id]
      );
      const storagePath = asset.rows[0]?.storage_path;
      if (!storagePath) throw new Error('ARCHIVE_ASSET_UNAVAILABLE');
      const object = await getR2ObjectByKey(storagePath);
      totalBytes += object.sizeBytes;
      if (totalBytes > ARCHIVE_MAX_BYTES) throw new ArchiveLimitError('ARCHIVE_LIMIT_EXCEEDED');
      entries.push({ name: item.name, body: object.body });
      await requireNativeDatabase().query(
        `update public.media_archive_jobs
            set processed_assets = $2, processed_bytes = $3, total_bytes = $3, updated_at = now()
          where id = $1 and status = 'processing'`,
        [jobId, index + 1, totalBytes]
      );
    }

    await assertNotCancelled(jobId);
    tempPath = join(tmpdir(), `verity-media-archive-${jobId}.zip`);
    const archiveSize = await writeZip(entries, tempPath);
    await assertNotCancelled(jobId);
    const archiveKey = `archives/${job.created_by}/${jobId}.zip`;
    await putR2FileByKey(archiveKey, tempPath);
    try {
      await assertNotCancelled(jobId);
    } catch (error) {
      await deleteR2ObjectByKey(archiveKey).catch(() => undefined);
      throw error;
    }
    await requireNativeDatabase().query(
      `update public.media_archive_jobs
          set status = 'ready', archive_key = $2, archive_size_bytes = $3,
              processed_assets = $4, processed_bytes = $5, total_bytes = $5,
              locked_at = null, completed_at = now(), updated_at = now()
        where id = $1 and status = 'processing'`,
      [jobId, archiveKey, archiveSize, manifest.length, totalBytes]
    );
  } catch (error) {
    if (error instanceof ArchiveCancelledError) {
      await requireNativeDatabase().query(
        `update public.media_archive_jobs
            set status = case when expires_at <= now() then 'expired' else 'cancelled' end,
                locked_at = null, updated_at = now()
          where id = $1 and status = 'processing'`,
        [jobId]
      ).catch(() => undefined);
    } else {
      const message = error instanceof ArchiveLimitError
        ? 'Tổng dung lượng vượt giới hạn 250 MB.'
        : 'Không thể chuẩn bị archive. Kiểm tra object và thử lại.';
      console.error('[media-archive] job failed', { jobId, reason: error instanceof Error ? error.message : 'UNKNOWN' });
      await markFailed(jobId, message).catch(() => undefined);
    }
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
  }
}

export async function expireMediaArchive(jobId: string): Promise<void> {
  const result = await requireNativeDatabase().query<{ archive_key: string | null; status: string }>(
    `update public.media_archive_jobs
        set status = 'expired', updated_at = now()
      where id = $1 and status = 'ready' and expires_at <= now()
      returning archive_key, status`,
    [jobId]
  );
  const key = result.rows[0]?.archive_key;
  if (key) await deleteR2ObjectByKey(key).catch(() => undefined);
}

export function archiveExpiryDate(): Date {
  return new Date(Date.now() + ARCHIVE_EXPIRY_HOURS * 60 * 60 * 1000);
}
