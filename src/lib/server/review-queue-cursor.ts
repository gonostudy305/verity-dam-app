export interface ReviewQueueCursor {
  createdAt: string;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeReviewQueueCursor(cursor: ReviewQueueCursor): string {
  const d = new Date(cursor.createdAt);
  const safeCreatedAt = Number.isNaN(d.getTime()) ? cursor.createdAt : d.toISOString();
  return Buffer.from(JSON.stringify({ createdAt: safeCreatedAt, id: cursor.id }), 'utf8').toString('base64url');
}

export function decodeReviewQueueCursor(value: string | null | undefined): ReviewQueueCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ReviewQueueCursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !UUID_RE.test(parsed.id)
    ) {
      return null;
    }
    const d = new Date(parsed.createdAt);
    if (Number.isNaN(d.getTime())) {
      return null;
    }
    return { createdAt: d.toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}
