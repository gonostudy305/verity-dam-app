/**
 * Guard chung cho mọi lượt fetch tới URL do người dùng nhập (import ảnh từ
 * link trang sản phẩm). Vì luồng khai báo SP cho phép dán **URL bất kỳ**, không
 * thể dùng domain allowlist — chốt chặn duy nhất là SSRF guard này.
 *
 * Bản gốc của `isPrivateAddress` + DNS-resolve-and-reject nằm trong
 * `src/app/api/settings/probe-models/route.ts`; ở đây tách ra dùng chung và vá
 * hai lỗ của bản cũ: redirect được follow thủ công (mỗi hop validate lại, chặn
 * open-redirect ra mạng nội bộ) và body bị cap theo byte thay vì đọc vô hạn.
 *
 * Hạn chế đã biết: sau khi `dns.lookup` xác nhận host là public, `fetch` tự
 * resolve lại — vẫn còn khe TOCTOU với DNS rebinding. Pin IP đòi hỏi custom
 * undici agent (không phải dependency khai báo), nên chấp nhận rủi ro còn lại
 * này cho luồng human-initiated, từng URL một.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

import { ApiError } from './http';

const MAX_REDIRECTS = 3;

export const VERITY_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 || // "this network"
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, gồm cả metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      // IPv4-mapped: đánh giá theo phần IPv4 thật.
      const mapped = normalized.slice('::ffff:'.length);
      return net.isIPv4(mapped) ? isPrivateAddress(mapped) : true;
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  return true; // Không parse được thì coi như không an toàn.
}

/** Kiểm tra hình dạng URL (scheme, port, credentials) — chưa chạm DNS. */
export function parsePublicHttpUrl(raw: unknown, code = 'INVALID_SOURCE_URL'): URL {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError(400, code, 'Thiếu URL nguồn.');
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(400, code, 'URL nguồn không hợp lệ.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, code, 'Chỉ hỗ trợ URL http hoặc https.');
  }
  if (url.username || url.password) {
    throw new ApiError(400, code, 'URL nguồn không được chứa thông tin đăng nhập.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new ApiError(400, code, 'URL nguồn chỉ được dùng cổng mặc định.');
  }
  return url;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupFn = (hostname) => dns.lookup(hostname, { all: true });

/** Chặn nếu *bất kỳ* địa chỉ nào của host nằm trong dải nội bộ. */
export async function assertPublicHost(
  hostname: string,
  lookup: LookupFn = defaultLookup,
  code = 'INVALID_SOURCE_URL'
): Promise<void> {
  // URL.hostname giữ nguyên ngoặc cho IPv6 literal (`[::1]`).
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(literal)) {
    // IP viết thẳng trong URL: quyết ngay, không đi qua DNS.
    if (isPrivateAddress(literal)) {
      throw new ApiError(400, code, 'URL nguồn trỏ tới địa chỉ nội bộ.');
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new ApiError(400, code, 'Không phân giải được tên miền của URL nguồn.');
  }
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ApiError(400, code, 'URL nguồn trỏ tới địa chỉ nội bộ.');
  }
}

export interface SafeFetchOptions {
  /** Cap dung lượng body; vượt là lỗi chứ không cắt ngắn. */
  maxBytes: number;
  timeoutMs?: number;
  accept?: string;
  code?: string;
  /** Chỉ dùng cho test: thay DNS và fetch thật. */
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

async function readCapped(response: Response, maxBytes: number, code: string): Promise<Buffer> {
  const tooLarge = () => new ApiError(413, code, 'Nội dung tại URL nguồn vượt quá giới hạn dung lượng.');
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch một URL người dùng nhập: validate từng hop redirect, cap byte, timeout.
 */
export async function safeFetch(rawUrl: unknown, options: SafeFetchOptions): Promise<SafeFetchResult> {
  const code = options.code || 'SOURCE_FETCH_FAILED';
  const lookup = options.lookup || defaultLookup;
  const doFetch = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let url = parsePublicHttpUrl(rawUrl, code);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname, lookup, code);

    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': VERITY_FETCH_USER_AGENT,
          Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
          'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ApiError(
        502,
        code,
        `Không tải được nội dung từ URL nguồn: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new ApiError(502, code, 'URL nguồn trả về redirect không có đích đến.');
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new ApiError(502, code, 'URL nguồn trả về redirect không hợp lệ.');
      }
      // Validate lại từ đầu: một redirect ra `http://169.254.169.254` phải chết ở đây.
      url = parsePublicHttpUrl(next.toString(), code);
      continue;
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw new ApiError(
          502,
          code,
          'Trang web nguồn chặn truy cập tự động (HTTP 403). Bạn có thể dán trực tiếp link ảnh bên dưới.'
        );
      }
      if (response.status === 404) {
        throw new ApiError(502, code, 'Không tìm thấy trang nguồn (HTTP 404). Vui lòng kiểm tra lại đường dẫn.');
      }
      throw new ApiError(502, code, `URL nguồn trả về lỗi ${response.status}.`);
    }

    return {
      buffer: await readCapped(response, options.maxBytes, code),
      contentType: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      finalUrl: url.toString(),
    };
  }

  throw new ApiError(502, code, 'URL nguồn chuyển hướng quá nhiều lần.');
}
