/**
 * Client for internal synchronous text embedding service (verity-embedding-runtime).
 *
 * Implements internal Docker network HTTP call with:
 * - Connection/read timeout <= 500ms (PROPOSED_NON_GATE_TARGET)
 * - Shared secret authentication header (X-Verity-Shared-Secret)
 * - Safe fail-closed error handling (graceful degradation to lexical search)
 *
 * Reference: docs/specs/p5b_runtime_prep/08_api_contracts.md
 */

import { CANONICAL_FUTURE_SEMANTIC_SPACE, CANONICAL_FUTURE_SEMANTIC_DIMENSION } from './search-intelligence-semantic';

const DEFAULT_RUNTIME_URL = process.env.VERITY_EMBEDDING_RUNTIME_URL || 'http://127.0.0.1:8801';
const SHARED_SECRET = process.env.VERITY_SHARED_SECRET || 'dev-shared-secret';
const REQUEST_TIMEOUT_MS = 500;

export interface TextEmbeddingResponse {
  spaceId: string;
  dimension: number;
  embedding: number[];
  latencyMs: number;
}

export async function fetchTextEmbedding(
  queryText: string,
  spaceId: string = CANONICAL_FUTURE_SEMANTIC_SPACE,
  runtimeBaseUrl: string = DEFAULT_RUNTIME_URL,
): Promise<number[] | null> {
  const trimmed = queryText.trim();
  if (!trimmed) {
    return null;
  }

  const endpoint = `${runtimeBaseUrl.replace(/\/+$/, '')}/embed/text`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Verity-Shared-Secret': SHARED_SECRET,
      },
      body: JSON.stringify({
        text: trimmed,
        space_id: spaceId,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 4xx/5xx responses gracefully degrade to lexical search
      return null;
    }

    const data = (await response.json()) as {
      space_id: string;
      dimension: number;
      embedding: number[];
    };

    if (
      data.space_id === spaceId &&
      data.dimension === CANONICAL_FUTURE_SEMANTIC_DIMENSION &&
      Array.isArray(data.embedding) &&
      data.embedding.length === CANONICAL_FUTURE_SEMANTIC_DIMENSION
    ) {
      return data.embedding;
    }

    return null;
  } catch (_error) {
    // Network error, abort/timeout, or service unavailable -> fail safe to lexical
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getEmbeddingClient() {
  return {
    async embedText(text: string): Promise<number[]> {
      const vec = await fetchTextEmbedding(text);
      if (!vec) {
        throw new Error('Failed to fetch text embedding');
      }
      return vec;
    },
  };
}
