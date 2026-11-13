import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeScopes,
  mcpOAuthIssuer,
  mcpOAuthResource,
  mcpProtectedResourceMetadata,
  oauthAuthorizeResumeUrl,
  safeRedirect,
  signedOAuthQuery,
} from './mcp-oauth';

const ENV = { BETTER_AUTH_URL: 'https://dam.example.test/' };

test('resource and issuer follow the public URLs the MCP server also derives', () => {
  assert.equal(mcpOAuthResource(ENV), 'https://dam.example.test/mcp');
  assert.equal(mcpOAuthResource({ ...ENV, VERITY_MCP_PUBLIC_URL: 'https://mcp.example.test/mcp/' }), 'https://mcp.example.test/mcp');
  assert.equal(mcpOAuthIssuer(ENV), 'https://dam.example.test/api/auth');
  assert.deepEqual(mcpProtectedResourceMetadata(ENV), {
    resource: 'https://dam.example.test/mcp',
    authorization_servers: ['https://dam.example.test/api/auth'],
    bearer_methods_supported: ['header'],
    resource_name: 'VerityDAM MCP',
  });
});

const SIGNED_LOGIN_QUERY =
  'response_type=code&client_id=c1&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
  '&scope=openid+offline_access&state=s1&code_challenge=abc&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fdam.example.test%2Fmcp&prompt=login+consent' +
  '&exp=123&ba_iat=100&ba_param=client_id&ba_param=resource&sig=xyz';

test('login resume replays the authorize request without signature params or prompt=login', () => {
  const url = oauthAuthorizeResumeUrl(`?${SIGNED_LOGIN_QUERY}`);
  assert.ok(url?.startsWith('/api/auth/oauth2/authorize?'));
  const params = new URLSearchParams(url!.split('?')[1]);
  assert.equal(params.get('client_id'), 'c1');
  assert.equal(params.get('resource'), 'https://dam.example.test/mcp');
  assert.equal(params.get('code_challenge'), 'abc');
  assert.equal(params.get('prompt'), 'consent');
  for (const key of ['sig', 'exp', 'ba_iat', 'ba_param']) assert.equal(params.has(key), false, key);
});

test('normal logins (no signed OAuth query) do not resume anything', () => {
  assert.equal(oauthAuthorizeResumeUrl('?returnUrl=%2Flibrary'), null);
  assert.equal(oauthAuthorizeResumeUrl('?client_id=c1&response_type=code'), null);
});

test('consent sends only the signed subset of the query', () => {
  const signed = new URLSearchParams(signedOAuthQuery(SIGNED_LOGIN_QUERY) ?? '');
  assert.deepEqual([...new Set(signed.keys())].sort(), ['ba_param', 'client_id', 'resource', 'sig']);
  assert.equal(signedOAuthQuery('client_id=c1'), null);
});

test('consent redirect accepts http(s) and native schemes, refuses script schemes', () => {
  assert.equal(safeRedirect('https://claude.ai/cb?code=1'), 'https://claude.ai/cb?code=1');
  assert.ok(safeRedirect('vscode://vscode.github-authentication/did-authenticate?code=1'));
  assert.equal(safeRedirect('javascript:alert(1)'), null);
  assert.equal(safeRedirect('data:text/html,hi'), null);
  assert.equal(safeRedirect(42), null);
});

test('scopes get Vietnamese labels and unknown scopes pass through', () => {
  assert.deepEqual(describeScopes('openid custom:x'), [
    { scope: 'openid', label: 'Xác nhận danh tính của bạn' },
    { scope: 'custom:x', label: 'custom:x' },
  ]);
  assert.deepEqual(describeScopes(null), []);
});
