import { createServer } from 'node:http';
import { resolve } from 'node:path';
import nextEnv from '@next/env';
import next from 'next';

const { loadEnvConfig } = nextEnv;

// Load .env, .env.local into process.env
loadEnvConfig(process.cwd());

// Loopback by default: the Cloudflare tunnel connects to 127.0.0.1, nothing else needs this port.
// Containers set VERITY_BIND_HOST=0.0.0.0 so the published port is reachable; compose then
// restricts the host side to 127.0.0.1.
const hostname = process.env.VERITY_BIND_HOST || '127.0.0.1';
const port = Number(process.env.VERITY_PORT) || 3000;

globalThis[Symbol.for('verity-dam.local-real-data-loopback')] = true;

const app = next({ dev: false, hostname, port, dir: process.cwd() });
const handle = app.getRequestHandler();
await app.prepare();

createServer((request, response) => {
  void handle(request, response);
}).once('error', (error) => {
  console.error('Unable to start Verity production server:', error.message);
  process.exit(1);
}).listen(port, hostname, () => {
  console.log(`VerityDAM production server ready at http://${hostname}:${port}`);
});
