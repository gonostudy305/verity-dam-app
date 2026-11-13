import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import next from 'next';

const localEnvironment = ['.env', '.env.local', '.env.development', '.env.development.local']
  .map((file) => resolve(process.cwd(), file))
  .filter(existsSync)
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const demoIsEnabled = /^VERITY_DAM_DEMO_MODE\s*=\s*true\s*$/m.test(localEnvironment);
const realDataDevIsEnabled = /^VERITY_DAM_REAL_DATA_DEV_MODE\s*=\s*true\s*$/m.test(localEnvironment);

if (demoIsEnabled && realDataDevIsEnabled) {
  console.error('VERITY_DAM_DEMO_MODE and VERITY_DAM_REAL_DATA_DEV_MODE cannot both be enabled.');
  process.exit(1);
}

const hostname = '127.0.0.1';
const port = 3000;

// Route handlers check this in-process marker before enabling the bootstrap
// admin session. A manually launched Next dev server cannot enable the mode by
// merely setting an environment variable.
globalThis[Symbol.for('verity-dam.local-real-data-loopback')] = true;

const serverDir = resolve(process.cwd(), '.next', 'server');
if (!existsSync(serverDir)) {
  mkdirSync(serverDir, { recursive: true });
}
const middlewareManifestPath = resolve(serverDir, 'middleware-manifest.json');
if (!existsSync(middlewareManifestPath)) {
  writeFileSync(
    middlewareManifestPath,
    JSON.stringify({ version: 3, middleware: {}, sortedMiddleware: [], functions: {} })
  );
}

const app = next({ dev: true, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();

process.on('uncaughtException', (err) => {
  console.error('Dev server uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Dev server unhandled rejection:', reason);
});

const server = createServer((request, response) => {
  void handle(request, response);
});

server.on('error', (error) => {
  console.error('Verity local server error:', error.message);
});

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(port, hostname, () => {
  console.log('Verity local server ready at http://' + hostname + ':' + port);
});

// Keep process active even if stdin disconnects
if (process.stdin && typeof process.stdin.resume === 'function') {
  try {
    process.stdin.resume();
  } catch {}
}
setInterval(() => {}, 10000);

