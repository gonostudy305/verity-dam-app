import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from './http';
import { isPrivateAddress, parsePublicHttpUrl, safeFetch, type LookupFn } from './url-fetch-guard';

test('isPrivateAddress: chặn loopback, RFC1918, CGNAT, link-local và metadata endpoint', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'not-an-ip',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} phải bị chặn`);
  }
});

test('isPrivateAddress: cho phép địa chỉ public', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:2800:220:1::1']) {
    assert.equal(isPrivateAddress(address), false, `${address} phải được phép`);
  }
});

test('parsePublicHttpUrl: chỉ nhận http/https, không credentials, không cổng lạ', () => {
  assert.equal(parsePublicHttpUrl('https://shop.example.com/p/1').hostname, 'shop.example.com');
  assert.equal(parsePublicHttpUrl('http://shop.example.com:80/p/1').protocol, 'http:');

  for (const raw of [
    'file:///etc/passwd',
    'ftp://example.com/a.jpg',
    'gopher://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:6379/',
    'khong-phai-url',
    '',
    null,
  ]) {
    assert.throws(() => parsePublicHttpUrl(raw), ApiError, `${String(raw)} phải bị từ chối`);
  }
});

/** DNS giả: mọi host public trừ những tên khai báo nội bộ. */
const lookup: LookupFn = async (hostname) => {
  if (hostname === 'internal.example.com') return [{ address: '10.1.2.3' }];
  if (hostname === 'metadata.example.com') return [{ address: '169.254.169.254' }];
  if (hostname === 'nxdomain.example.com') throw new Error('ENOTFOUND');
  return [{ address: '93.184.216.34' }];
};

function jsonResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html', ...headers } });
}

test('safeFetch: chặn host phân giải ra địa chỉ nội bộ trước khi gọi mạng', async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return jsonResponse('secret');
  }) as unknown as typeof fetch;

  for (const url of ['http://internal.example.com/', 'https://metadata.example.com/latest/meta-data/']) {
    await assert.rejects(() => safeFetch(url, { maxBytes: 1000, lookup, fetchImpl }), ApiError);
  }
  await assert.rejects(() => safeFetch('https://nxdomain.example.com/', { maxBytes: 1000, lookup, fetchImpl }), ApiError);
  assert.equal(called, 0, 'không được phát request nào');
});

test('safeFetch: redirect từ host public sang IP nội bộ bị chặn ở hop sau', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string) => {
    seen.push(input);
    if (input.startsWith('https://shop.example.com/')) {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    return jsonResponse('secret');
  }) as unknown as typeof fetch;

  await assert.rejects(() => safeFetch('https://shop.example.com/p/1', { maxBytes: 1000, lookup, fetchImpl }), ApiError);
  assert.deepEqual(seen, ['https://shop.example.com/p/1'], 'chỉ hop đầu được phát');
});

test('safeFetch: IP nội bộ viết thẳng trong URL bị chặn mà không cần DNS', async () => {
  const neverLookup: LookupFn = async () => {
    throw new Error('không được gọi DNS cho IP literal');
  };
  const fetchImpl = (async () => jsonResponse('secret')) as unknown as typeof fetch;

  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
    await assert.rejects(
      () => safeFetch(url, { maxBytes: 1000, lookup: neverLookup, fetchImpl }),
      (error: unknown) => error instanceof ApiError && error.status === 400,
      `${url} phải bị chặn`
    );
  }
});

test('safeFetch: follow redirect hợp lệ và trả về URL cuối', async () => {
  const fetchImpl = (async (input: string) => {
    if (input === 'https://shop.example.com/p/1') {
      return new Response(null, { status: 301, headers: { location: '/p/1-final' } });
    }
    return jsonResponse('<html>ok</html>');
  }) as unknown as typeof fetch;

  const result = await safeFetch('https://shop.example.com/p/1', { maxBytes: 1000, lookup, fetchImpl });
  assert.equal(result.finalUrl, 'https://shop.example.com/p/1-final');
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.buffer.toString(), '<html>ok</html>');
});

test('safeFetch: dừng khi redirect quá nhiều lần', async () => {
  let hops = 0;
  const fetchImpl = (async () => {
    hops += 1;
    return new Response(null, { status: 302, headers: { location: `https://shop.example.com/hop-${hops}` } });
  }) as unknown as typeof fetch;

  await assert.rejects(() => safeFetch('https://shop.example.com/p/1', { maxBytes: 1000, lookup, fetchImpl }), ApiError);
  assert.equal(hops, 4, 'hop đầu + tối đa 3 redirect');
});

test('safeFetch: cap byte theo content-length và theo stream thực tế', async () => {
  const declared = (async () =>
    new Response('x'.repeat(10), { status: 200, headers: { 'content-length': '10' } })) as unknown as typeof fetch;
  await assert.rejects(
    () => safeFetch('https://shop.example.com/big', { maxBytes: 5, lookup, fetchImpl: declared }),
    ApiError
  );

  // Content-length nói dối: cap phải bắt được khi đọc stream.
  const lying = (async () =>
    new Response('x'.repeat(50), { status: 200, headers: { 'content-length': '1' } })) as unknown as typeof fetch;
  await assert.rejects(
    () => safeFetch('https://shop.example.com/big', { maxBytes: 5, lookup, fetchImpl: lying }),
    ApiError
  );
});

test('safeFetch: lỗi HTTP upstream thành lỗi 502 có mã', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    () => safeFetch('https://shop.example.com/p/1', { maxBytes: 1000, lookup, fetchImpl }),
    (error: unknown) => error instanceof ApiError && error.status === 502
  );
});
