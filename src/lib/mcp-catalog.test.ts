import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_TOOLS, mcpClientConfigs, mcpInstallLinks, toolsForRole } from './mcp-catalog';

const ENDPOINT = 'https://dam.example.test/mcp';
const TOKEN = 'verity_mcp_live_abc';

function config(id: string) {
  const found = mcpClientConfigs(ENDPOINT, TOKEN).find((item) => item.id === id);
  assert.ok(found, id);
  return found;
}

test('catalog has 13 unique tools and roles widen monotonically', () => {
  assert.equal(MCP_TOOLS.length, 13);
  assert.equal(new Set(MCP_TOOLS.map((tool) => tool.name)).size, 13);
  assert.equal(toolsForRole('viewer').length, 7);
  assert.equal(toolsForRole('contributor').length, 9);
  assert.equal(toolsForRole('reviewer').length, 13);
  assert.ok(toolsForRole('viewer').every((tool) => tool.minRole === 'viewer'));
});

test('Claude Desktop config uses the mcp-remote stdio bridge with the token in env', () => {
  const parsed = JSON.parse(config('claude-desktop').code);
  const server = parsed.mcpServers['verity-dam'];
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', 'mcp-remote', ENDPOINT, '--header', 'Authorization:${VERITY_MCP_AUTH}']);
  assert.equal(server.env.VERITY_MCP_AUTH, `Bearer ${TOKEN}`);
  assert.equal(server.transport, undefined);
});

test('Cursor and VS Code configs use each client schema', () => {
  const cursor = JSON.parse(config('cursor').code);
  assert.deepEqual(cursor.mcpServers['verity-dam'], { url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } });
  const vscode = JSON.parse(config('vscode').code);
  assert.deepEqual(vscode.servers['verity-dam'], { type: 'http', url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } });
});

test('Claude Code command and generic config carry endpoint and bearer token', () => {
  assert.equal(
    config('claude-code').code,
    `claude mcp add --transport http verity-dam ${ENDPOINT} --header "Authorization: Bearer ${TOKEN}"`
  );
  const generic = JSON.parse(config('generic').code);
  assert.equal(generic.url, ENDPOINT);
  assert.equal(generic.headers.Authorization, `Bearer ${TOKEN}`);
});

test('install links encode the server config for Cursor and VS Code', () => {
  const links = mcpInstallLinks(ENDPOINT, TOKEN);
  const cursorUrl = new URL(links.cursor);
  assert.equal(cursorUrl.protocol, 'cursor:');
  assert.equal(cursorUrl.searchParams.get('name'), 'verity-dam');
  const decoded = JSON.parse(Buffer.from(cursorUrl.searchParams.get('config') ?? '', 'base64').toString('utf8'));
  assert.deepEqual(decoded, { url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } });

  assert.ok(links.vscode.startsWith('vscode:mcp/install?'));
  const vscode = JSON.parse(decodeURIComponent(links.vscode.slice('vscode:mcp/install?'.length)));
  assert.deepEqual(vscode, { name: 'verity-dam', type: 'http', url: ENDPOINT, headers: { Authorization: `Bearer ${TOKEN}` } });
});
