import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const hostname = '127.0.0.1';
const port = process.env.PLAYWRIGHT_PORT || '3101';
const nextBinary = resolve(process.cwd(), 'node_modules/next/dist/bin/next');
const serverDir = resolve(process.cwd(), '.next', 'server');

if (!existsSync(serverDir)) mkdirSync(serverDir, { recursive: true });

// Browser tests always mock the API boundary. These explicit values prevent a
// test process from accidentally inheriting the developer's live-data mode.
const child = spawn(
  process.execPath,
  [nextBinary, 'dev', '-H', hostname, '-p', port],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VERITY_DAM_DEMO_MODE: 'true',
      VERITY_DAM_REAL_DATA_DEV_MODE: 'false',
    },
  }
);

const shutdown = (signal) => {
  child.kill(signal);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
