import { timingSafeEqual } from 'node:crypto';

import { ApiError } from './http';

function providedToken(header: string | null) {
  if (!header) return '';
  const [scheme, value] = header.split(/\s+/, 2);
  return scheme?.toLowerCase() === 'bearer' ? value || '' : '';
}

/** Validate the WordPress machine token without leaking which side was wrong. */
export function requireWordPressSyncToken(authorization: string | null) {
  const expected = process.env.VERITY_WORDPRESS_SYNC_TOKEN || '';
  const received = providedToken(authorization);
  if (expected.length < 32 || received.length !== expected.length) {
    throw new ApiError(401, 'WORDPRESS_AUTHENTICATION_REQUIRED', 'WordPress token is invalid.');
  }
  const valid = timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  if (!valid) {
    throw new ApiError(401, 'WORDPRESS_AUTHENTICATION_REQUIRED', 'WordPress token is invalid.');
  }
}

export interface MediaCursorPayload {
  t: string; // ISO timestamp
  id: string; // UUID
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ISO_DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

/** Encodes a composite cursor { t, id } into an opaque base64url string. */
export function encodeMediaCursor(payload: MediaCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decodes and strictly validates an opaque base64url composite cursor. */
export function decodeMediaCursor(rawCursor: string): MediaCursorPayload {
  try {
    const jsonStr = Buffer.from(rawCursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Cursor must be a JSON object.');
    }
    const { t, id } = parsed as Record<string, unknown>;
    if (typeof t !== 'string' || !ISO_DATE_REGEX.test(t) || Number.isNaN(Date.parse(t))) {
      throw new Error('Cursor timestamp must be a valid ISO-8601 date.');
    }
    if (typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new Error('Cursor ID must be a valid UUID.');
    }
    return { t, id };
  } catch (err: any) {
    throw new ApiError(400, 'INVALID_CURSOR', err.message || 'Invalid cursor format.');
  }
}

