import { NextRequest, NextResponse } from 'next/server';
import dns from 'node:dns/promises';
import net from 'node:net';

import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeAdmin } from '@/lib/server/native-auth';
import { getSharedVisionRuntimeConfig } from '@/lib/server/vision-config';

export const dynamic = 'force-dynamic';

function isPrivateAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
  }
  return true;
}

/**
 * POST /api/settings/probe-models
 * Body: { baseUrl: string; apiKey: string }
 *
 * Server-side proxies GET {baseUrl}/models so the API key is never
 * exposed to the browser. Returns the raw OpenAI-compatible model list.
 */
export async function POST(request: NextRequest) {
  try {
    await requireNativeAdmin();

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw new ApiError(400, 'INVALID_REQUEST', 'Request body is required.');
    }
    const { baseUrl, apiKey } = body as Record<string, unknown>;

    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
      throw new ApiError(400, 'INVALID_BASE_URL', 'Base URL is required.');
    }
    let resolvedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!resolvedApiKey) {
      try {
        const runtime = await getSharedVisionRuntimeConfig();
        if (runtime.apiKey) {
          resolvedApiKey = runtime.apiKey;
        }
      } catch {
        // No stored key
      }
    }
    if (!resolvedApiKey) {
      throw new ApiError(400, 'API_KEY_REQUIRED', 'API key is required to probe models.');
    }

    // Validate baseUrl is HTTPS
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl.trim().replace(/\/$/, ''));
    } catch {
      throw new ApiError(400, 'INVALID_BASE_URL', 'Base URL is not a valid URL.');
    }
    const localDevProbe = process.env.NODE_ENV === 'development' && process.env.VERITY_ALLOW_LOCAL_MODEL_PROBE === 'true';
    if (parsedUrl.protocol !== 'https:' || (parsedUrl.port && parsedUrl.port !== '443')) {
      throw new ApiError(400, 'INVALID_BASE_URL', 'Base URL must use HTTPS.');
    }
    if (!localDevProbe && (parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '::1')) {
      throw new ApiError(400, 'INVALID_BASE_URL', 'Local model endpoints are disabled outside explicit development mode.');
    }
    if (!localDevProbe) {
      let addresses: Array<{ address: string }>;
      try { addresses = await dns.lookup(parsedUrl.hostname, { all: true }); }
      catch { throw new ApiError(400, 'INVALID_BASE_URL', 'Base URL hostname could not be resolved.'); }
      if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
        throw new ApiError(400, 'INVALID_BASE_URL', 'Base URL resolves to a private or local network address.');
      }
    }

    const modelsUrl = `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}/models`;

    let upstream: Response;
    try {
      upstream = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${resolvedApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new ApiError(502, 'PROBE_FETCH_FAILED', `Could not reach ${modelsUrl}: ${message}`);
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      throw new ApiError(
        502,
        'PROBE_UPSTREAM_ERROR',
        `Endpoint returned ${upstream.status}: ${errText.slice(0, 200)}`
      );
    }

    const data = await upstream.json().catch(() => null);
    if (!data) {
      throw new ApiError(502, 'PROBE_INVALID_RESPONSE', 'Endpoint did not return valid JSON.');
    }

    // Normalize: OpenAI format → { data: [{ id, object }] }
    // Also support bare array responses
    let models: { id: string; object?: string }[];
    if (Array.isArray(data)) {
      models = data as { id: string }[];
    } else if (Array.isArray(data?.data)) {
      models = data.data as { id: string }[];
    } else {
      throw new ApiError(502, 'PROBE_UNKNOWN_FORMAT', 'Response does not match OpenAI model list format.');
    }

    // Return deduplicated, sorted model IDs
    const modelIds = [...new Set(models.map((m) => m.id).filter(Boolean))].sort();
    return NextResponse.json({ models: modelIds });
  } catch (error) {
    return errorResponse(error);
  }
}
