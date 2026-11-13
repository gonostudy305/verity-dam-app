/**
 * ai-vision.ts
 * OpenAI-compatible Chat Completions Vision — utility layer
 *
 * Chuẩn: POST /v1/chat/completions
 * Content: messages.content dạng Array of Content Parts (text + image_url)
 */

import type { AIVisionConfig, VisionDetail } from '@/types/media';

// ─── Storage ──────────────────────────────────────────────────────────────────

/** [I-1] Namespace prefix tránh key collision trong localStorage */
const STORAGE_KEY = 'verity-media:vision-config';
const TEST_IMAGE_STORAGE_KEY = 'verity-media:vision-test-image-url';

/**
 * URL ảnh mẫu mặc định để kiểm tra kết nối AI Vision.
 * Ưu tiên biến môi trường NEXT_PUBLIC_VISION_TEST_IMAGE_URL, fallback về ảnh sản phẩm LocknLock chuẩn.
 */
export const DEFAULT_VISION_TEST_IMAGE_URL =
  process.env.NEXT_PUBLIC_VISION_TEST_IMAGE_URL ||
  'https://www.locknlock.vn/dw/image/v2/BLBT_PRD/on/demandware.static/-/Sites-locknlock-shared-master/default/dwf0e56110/images/thumbnails/2.Food%20Containers/1.Food%20Containers/1.Glass%20Containers/LLG428-A32344781_1.jpg?sw=800&q=69';

export function loadVisionTestImageUrl(): string {
  if (typeof window === 'undefined') return DEFAULT_VISION_TEST_IMAGE_URL;
  try {
    const saved = localStorage.getItem(TEST_IMAGE_STORAGE_KEY);
    return saved && saved.trim() ? saved.trim() : DEFAULT_VISION_TEST_IMAGE_URL;
  } catch {
    return DEFAULT_VISION_TEST_IMAGE_URL;
  }
}

export function saveVisionTestImageUrl(url: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (url && url.trim()) {
      localStorage.setItem(TEST_IMAGE_STORAGE_KEY, url.trim());
    } else {
      localStorage.removeItem(TEST_IMAGE_STORAGE_KEY);
    }
  } catch {
    // Bỏ qua lỗi hạn mức lưu trữ
  }
}

export const DEFAULT_VISION_CONFIG: AIVisionConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: '',                          // Không hardcode — user nhập qua UI, lưu localStorage
  model: 'cx/gpt-6-luna',            // Vision model thực tế trên 9Router
  detail: 'high',                      // high = đọc chính xác chữ nhỏ, SKU
  maxTokens: 1000,
  systemPrompt:
    'Cấu hình production nằm trên worker. Vision chỉ tạo caption và metadata mở; SKU luôn do embedding reference matching quyết định.',
};

/**
 * Lưu cấu hình vào localStorage.
 * [C-1] Guard: chỉ chạy phía browser.
 */
export function saveVisionConfig(config: AIVisionConfig): void {
  if (typeof window === 'undefined') return;
  try {
    // API keys must never persist in the browser. The production worker reads
    // server-only credentials and the UI may retain only harmless preferences.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...config, apiKey: '' }));
  } catch {
    // Bỏ qua nếu storage bị block (private mode, quota exceeded, v.v.)
  }
}

/**
 * Đọc cấu hình từ localStorage.
 * [C-1] Guard: trả về default config khi chạy trên server (SSR).
 */
export function loadVisionConfig(): AIVisionConfig {
  if (typeof window === 'undefined') return DEFAULT_VISION_CONFIG;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISION_CONFIG;
    const parsed = JSON.parse(raw) as Partial<AIVisionConfig>;
    const safeConfig = { ...DEFAULT_VISION_CONFIG, ...parsed, apiKey: '' };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(safeConfig));
    return safeConfig;
  } catch {
    return DEFAULT_VISION_CONFIG;
  }
}

// ─── Payload Builder ──────────────────────────────────────────────────────────

export interface VisionPayloadOptions {
  /** Prompt văn bản gửi kèm hình ảnh */
  userPrompt: string;
  /** URL công khai hoặc Data URI (data:image/...;base64,...) */
  imageUrl: string;
  detail?: VisionDetail;
}

/**
 * Xây dựng JSON payload theo chuẩn OpenAI Chat Completions Vision.
 * messages.content là Array of Content Parts: [{type:'text'}, {type:'image_url'}]
 */
export function buildVisionPayload(
  config: AIVisionConfig,
  opts: VisionPayloadOptions
) {
  const { userPrompt, imageUrl, detail } = opts;
  const resolvedDetail = detail ?? config.detail;

  return {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: [
      ...(config.systemPrompt
        ? [{ role: 'system', content: config.systemPrompt }]
        : []),
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          {
            type: 'image_url',
            image_url: {
              url: imageUrl,
              detail: resolvedDetail,
            },
          },
        ],
      },
    ],
  };
}

// ─── Fetch Client ─────────────────────────────────────────────────────────────

export interface VisionAnalysisResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/**
 * Gọi endpoint /v1/chat/completions với cấu trúc Vision.
 * [I-2] AbortController với timeout 15s — UI không treo vô thời hạn.
 * [C-2] Lưu ý: gọi trực tiếp từ browser — endpoint cần trả về CORS header.
 */
export async function analyzeImageWithVision(
  config: AIVisionConfig,
  opts: VisionPayloadOptions
): Promise<VisionAnalysisResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // The browser never contacts the provider and never supplies a prompt/model
    // for ingestion. /api/vision-proxy uses the server-only metadata contract.
    const res = await fetch('/api/vision-proxy', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl: opts.imageUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new VisionApiError(data.error?.message || `HTTP ${res.status}`, res.status);
    }
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: data.model ?? config.model,
      usage: data.usage,
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new VisionApiError('Timeout sau 15 giây — kiểm tra lại endpoint hoặc kết nối mạng.', 0);
    }
    if (err instanceof VisionApiError) throw err;
    throw new VisionApiError(`Network error: ${(err as Error).message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Connection Test ──────────────────────────────────────────────────────────

export interface TestConnectionResult {
  ok: boolean;
  message: string;
  responseSnippet?: string;
  httpStatus?: number;
  latencyMs?: number;
}

/**
 * Gửi 1 request test nhỏ (1 token) để kiểm tra endpoint + API key.
 * Dùng ảnh tĩnh LocknLock nếu không cung cấp imageUrl.
 */
export async function testVisionConnection(
  config: AIVisionConfig,
  imageUrl?: string
): Promise<TestConnectionResult> {
  const testImageUrl = imageUrl || loadVisionTestImageUrl();

  const t0 = Date.now();
  try {
    const result = await analyzeImageWithVision(config, {
      userPrompt: 'Mô tả ngắn gọn hình ảnh này trong 1 câu.',
      imageUrl: testImageUrl,
      detail: 'low', // Tiết kiệm token khi test
    });
    return {
      ok: true,
      message: `✅ Kết nối thành công — Model: ${result.model}`,
      responseSnippet: result.content.slice(0, 200),
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
      httpStatus: err instanceof VisionApiError ? err.status : undefined,
      latencyMs: Date.now() - t0,
    };
  }
}

// ─── Error Class ──────────────────────────────────────────────────────────────

export class VisionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'VisionApiError';
  }
}

// ─── Code Snippet Generator ───────────────────────────────────────────────────

/** Tạo chuỗi cURL command với cấu hình hiện tại */
export function generateCurlSnippet(config: AIVisionConfig, imageUrl: string): string {
  return `curl -X POST "${config.baseUrl.replace(/\/$/, '')}/chat/completions" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${config.apiKey || 'sk-your-api-key'}" \\
  -d '{
    "model": "${config.model}",
    "max_tokens": ${config.maxTokens},
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Phân tích và mô tả chi tiết sản phẩm trong hình:"},
          {
            "type": "image_url",
            "image_url": {
              "url": "${imageUrl || DEFAULT_VISION_TEST_IMAGE_URL}",
              "detail": "${config.detail}"
            }
          }
        ]
      }
    ]
  }'`;
}

/** Tạo Python snippet (OpenAI SDK) với cấu hình hiện tại */
export function generatePythonSnippet(config: AIVisionConfig): string {
  return `import base64
from openai import OpenAI

def encode_image(image_path):
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

client = OpenAI(
    base_url="${config.baseUrl.replace(/\/$/, '')}",
    api_key="${config.apiKey || 'sk-your-api-key'}"
)

base64_image = encode_image("product.jpg")

response = client.chat.completions.create(
    model="${config.model}",
    max_tokens=${config.maxTokens},
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Phân tích và mô tả chi tiết sản phẩm trong hình:"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{base64_image}",
                        "detail": "${config.detail}"
                    }
                }
            ]
        }
    ]
)

print(response.choices[0].message.content)`;
}

/** Tạo Node.js snippet (Fetch API) với cấu hình hiện tại */
export function generateNodeSnippet(config: AIVisionConfig): string {
  return `import fs from 'fs';

const imageBase64 = fs.readFileSync('product.png', { encoding: 'base64' });

const response = await fetch("${config.baseUrl.replace(/\/$/, '')}/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${config.apiKey || 'sk-your-api-key'}"
  },
  body: JSON.stringify({
    model: "${config.model}",
    max_tokens: ${config.maxTokens},
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Phân tích và mô tả chi tiết sản phẩm trong hình:" },
          {
            type: "image_url",
            image_url: {
              url: \`data:image/png;base64,\${imageBase64}\`,
              detail: "${config.detail}"
            }
          }
        ]
      }
    ]
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);`;
}
