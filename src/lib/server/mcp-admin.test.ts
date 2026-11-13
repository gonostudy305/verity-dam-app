import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  generateMcpKey,
  isKnownTool,
  keyStatus,
  parseNewKeyInput,
  probeMcpHealth,
  probePublicRoute,
  publicMcpUrl,
} from './mcp-admin';

test('generated key is stored as SHA-256 of the raw token with a short visible prefix', () => {
  const key = generateMcpKey();
  assert.match(key.rawKey, /^verity_mcp_live_[0-9a-f]{48}$/);
  assert.equal(key.keyHash, crypto.createHash('sha256').update(key.rawKey).digest('hex'));
  assert.ok(key.keyPrefix.endsWith('...'));
  assert.ok(key.rawKey.startsWith(key.keyPrefix.slice(0, -3)));
  assert.ok(key.keyPrefix.length <= 64);
});

test('new key input validates role, email and expiry', () => {
  assert.deepEqual(parseNewKeyInput({ name: ' Bot ', email: 'Bot@Example.TEST', role: 'reviewer', expiresInDays: 90 }), {
    name: 'Bot',
    email: 'bot@example.test',
    role: 'reviewer',
    expiresInDays: 90,
  });
  assert.equal(parseNewKeyInput({ name: 'Bot', email: 'b@x.io' }).role, 'viewer');
  assert.equal(parseNewKeyInput({ name: 'Bot', email: 'b@x.io' }).expiresInDays, null);
  assert.throws(() => parseNewKeyInput({ name: 'Bot', email: 'b@x.io', role: 'admin' }), /viewer, contributor hoặc reviewer/);
  assert.throws(() => parseNewKeyInput({ name: 'Bot', email: 'not-an-email' }), /email/i);
  assert.throws(() => parseNewKeyInput({ name: 'Bot', email: 'b@x.io', expiresInDays: 7 }), /30, 90, 365/);
  assert.throws(() => parseNewKeyInput(null), /bắt buộc/);
});

test('key status prefers revoked, then expired', () => {
  const now = new Date('2026-11-13T00:00:00Z');
  assert.equal(keyStatus(null, null, now), 'active');
  assert.equal(keyStatus(null, '2026-12-01T00:00:00Z', now), 'active');
  assert.equal(keyStatus(null, '2026-11-01T00:00:00Z', now), 'expired');
  assert.equal(keyStatus('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z', now), 'revoked');
});

test('only catalog tools can be toggled', () => {
  assert.equal(isKnownTool('media_search'), true);
  assert.equal(isKnownTool('drop_table'), false);
  assert.equal(isKnownTool(undefined), false);
});

test('health probe reports unconfigured, healthy and failing servers', async () => {
  assert.equal((await probeMcpHealth(undefined)).configured, false);

  const healthy = await probeMcpHealth('http://mcp:8000/', (async (url: string) => {
    assert.equal(url, 'http://mcp:8000/health');
    return new Response(JSON.stringify({ status: 'ok', protocol_version: '2026-07-28', rate_limit_per_minute: 60 }), { status: 200 });
  }) as typeof fetch);
  assert.equal(healthy.reachable, true);
  assert.equal(healthy.protocolVersion, '2026-07-28');
  assert.equal(healthy.rateLimitPerMinute, 60);

  const down = await probeMcpHealth('http://mcp:8000', (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
  assert.equal(down.reachable, false);
  assert.match(down.error ?? '', /ECONNREFUSED/);
});

test('public route probe distinguishes MCP 401 from the web app 404', async () => {
  const mcp = await probePublicRoute('https://x/mcp', (async () =>
    new Response('{}', { status: 401, headers: { 'www-authenticate': 'Bearer realm="VerityDAM MCP"' } })) as typeof fetch);
  assert.equal(mcp.state, 'routed');

  const web = await probePublicRoute('https://x/mcp', (async () => new Response('not found', { status: 404 })) as typeof fetch);
  assert.equal(web.state, 'not_routed');
  assert.equal(web.status, 404);

  const generic401 = await probePublicRoute('https://x/mcp', (async () => new Response('', { status: 401 })) as typeof fetch);
  assert.equal(generic401.state, 'not_routed');
});

test('public MCP URL comes from override or auth base URL', () => {
  assert.equal(publicMcpUrl({ VERITY_MCP_PUBLIC_URL: 'https://mcp.example/mcp/' }), 'https://mcp.example/mcp');
  assert.equal(publicMcpUrl({ BETTER_AUTH_URL: 'https://dam.example/' }), 'https://dam.example/mcp');
  assert.equal(publicMcpUrl({}), null);
});
