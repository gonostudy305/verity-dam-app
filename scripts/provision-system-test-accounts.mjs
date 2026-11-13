#!/usr/bin/env node
// Idempotently provisions the four Verity role fixtures. Credentials are read
// from environment variables and are never printed or committed.
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provisionBetterAuthAccount } from './lib/provision-better-auth-account.mjs';

// Auto-load .env and .env.local if not already provided in environment
for (const envFile of ['.env', '.env.local']) {
  const filePath = resolve(process.cwd(), envFile);
  if (existsSync(filePath)) {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = (match[2] || '').replace(/^["']|["']$/g, '').trim();
      }
    }
  }
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value.startsWith('--')) args.set(value.slice(2), process.argv[index + 1]);
}

const baseUrl = (args.get('base-url') || process.env.BETTER_AUTH_URL || '').replace(/\/$/, '');
const databaseUrl = process.env.DATABASE_URL;
const provisioningToken = process.env.VERITY_AUTH_PROVISIONING_TOKEN || process.env.Verity_AUTH_PROVISIONING_TOKEN;
const roles = ['viewer', 'contributor', 'reviewer', 'admin'];

if (!baseUrl || !databaseUrl) throw new Error('Require --base-url/BETTER_AUTH_URL and DATABASE_URL.');
if (!provisioningToken) throw new Error('Require VERITY_AUTH_PROVISIONING_TOKEN; public self-signup is disabled.');

for (const role of roles) {
  const prefixUpper = `VERITY_INTERNAL_TEST_${role.toUpperCase()}`;
  const prefixTitle = `Verity_INTERNAL_TEST_${role.toUpperCase()}`;
  const email = process.env[`${prefixUpper}_EMAIL`] || process.env[`${prefixTitle}_EMAIL`];
  const password = process.env[`${prefixUpper}_PASSWORD`] || process.env[`${prefixTitle}_PASSWORD`];
  const name = process.env[`${prefixUpper}_NAME`] || process.env[`${prefixTitle}_NAME`] || `Verity System ${role}`;
  if (!email || !password) throw new Error(`Missing ${prefixUpper}_EMAIL or ${prefixUpper}_PASSWORD.`);

  const result = await provisionBetterAuthAccount({ baseUrl, email, password, name, role, databaseUrl, provisioningToken });
  console.log(`Provisioned ${result.email} with role ${result.role} (id=${result.id}).`);
}
