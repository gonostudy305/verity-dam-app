import { NextRequest, NextResponse } from 'next/server';
import { ApiError, errorResponse } from '@/lib/server/http';
import { requireNativeContributor } from '@/lib/server/native-auth';
import { requireNativeDatabase } from '@/lib/server/native-db';
import { getSharedVisionRuntimeConfig, type VisionRuntimeConfig } from '@/lib/server/vision-config';

export const dynamic = 'force-dynamic';
const MAX_VISION_BODY_BYTES = 5_000_000;

async function consumeQuota(userId: string) {
  const client = await requireNativeDatabase().connect();
  try {
    await client.query('begin');
    const result = await client.query<{ request_count: number }>(
      `insert into public.vision_rate_limits(key, window_started_at, request_count)
       values ($1, now(), 1)
       on conflict(key) do update set
         window_started_at = case when public.vision_rate_limits.window_started_at <= now() - interval '1 minute' then now() else public.vision_rate_limits.window_started_at end,
         request_count = case when public.vision_rate_limits.window_started_at <= now() - interval '1 minute' then 1 else public.vision_rate_limits.request_count + 1 end
       returning request_count`, [userId]
    );
    const configured = Number(process.env.AI_VISION_RATE_LIMIT_PER_MINUTE || 10);
    const limit = Number.isInteger(configured) ? Math.min(Math.max(configured, 1), 60) : 10;
    if ((result.rows[0]?.request_count || 0) > limit) {
      await client.query('rollback');
      throw new ApiError(429, 'VISION_RATE_LIMITED', 'Đã đạt giới hạn gọi AI trong một phút.');
    }
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch {}
    throw error;
  } finally { client.release(); }
}

async function readJsonWithinLimit(request: NextRequest) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_VISION_BODY_BYTES) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Payload AI vượt quá giới hạn 5 MB.');
  }
  if (!request.body) throw new ApiError(400, 'INVALID_REQUEST', 'Thiếu payload cho yêu cầu AI.');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength; if (total > MAX_VISION_BODY_BYTES) { await reader.cancel(); throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Payload AI vượt quá giới hạn 5 MB.'); }
    chunks.push(value);
  }
  try { const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_REQUEST', 'Nội dung yêu cầu phải là JSON hợp lệ.'); }
}

function buildProviderPayload(value: unknown, config: VisionRuntimeConfig) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'INVALID_REQUEST', 'Thiếu payload cho yêu cầu AI.');
  const imageUrl = (value as Record<string, unknown>).imageUrl;
  if (typeof imageUrl !== 'string' || imageUrl.length < 10 || imageUrl.length > MAX_VISION_BODY_BYTES) throw new ApiError(400, 'INVALID_REQUEST', 'Cần cung cấp URL hoặc data URL ảnh hợp lệ.');
  if (!imageUrl.startsWith('data:image/') && !/^https:\/\//i.test(imageUrl)) throw new ApiError(400, 'INVALID_REQUEST', 'Ảnh Vision phải dùng HTTPS hoặc data:image.');
  return { model: config.model, max_tokens: config.maxTokens, messages: [
    { role: 'system', content: `Generate Vietnamese open image metadata only. Never infer, output, or mention SKU/product codes; SKU matching is a separate embedding-reference system.\n${config.systemPrompt}` },
    { role: 'user', content: [{ type: 'text', text: 'Mô tả ảnh bằng caption ngắn và metadata mở, không có SKU.' }, { type: 'image_url', image_url: { url: imageUrl, detail: config.detail } }] },
  ] };
}

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireNativeContributor();
    const body = await readJsonWithinLimit(request);
    const config = await getSharedVisionRuntimeConfig();
    const target = new URL(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`);
    if (target.protocol !== 'https:' || target.username || target.password) throw new ApiError(503, 'VISION_PROXY_NOT_CONFIGURED', 'Shared Vision configuration is invalid.');
    await consumeQuota(user.id);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(target, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(buildProviderPayload(body, config)) }).finally(() => clearTimeout(timer));
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') return NextResponse.json({ error: { code: 'VISION_TIMEOUT', message: 'AI endpoint không phản hồi sau 20 giây.' } }, { status: 504 });
    return errorResponse(error);
  }
}
