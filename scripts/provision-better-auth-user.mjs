#!/usr/bin/env node
// Provision a Better Auth account through the public sign-up contract, then
// assign its Verity role using the protected PostgreSQL connection. Passwords
// are accepted only through environment variables and never logged.
import process from 'node:process';
import { provisionBetterAuthAccount } from './lib/provision-better-auth-account.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value.startsWith('--')) args.set(value.slice(2), process.argv[index + 1]);
}
const baseUrl = (args.get('base-url') || process.env.BETTER_AUTH_URL || '').replace(/\/$/, '');
const email = args.get('email') || process.env.Verity_PROVISION_EMAIL;
const password = args.get('password') || process.env.Verity_PROVISION_PASSWORD;
const name = args.get('name') || email;
const role = args.get('role') || 'viewer';
const databaseUrl = process.env.DATABASE_URL;
const provisioningToken = process.env.Verity_AUTH_PROVISIONING_TOKEN;
if (!baseUrl || !email || !password || !databaseUrl) throw new Error('Require --base-url/--email/--password and DATABASE_URL (or matching environment variables).');
if (!provisioningToken) throw new Error('Require Verity_AUTH_PROVISIONING_TOKEN; public self-signup is disabled.');
if (!['viewer', 'contributor', 'reviewer', 'admin'].includes(role)) throw new Error('Invalid role.');

const result = await provisionBetterAuthAccount({ baseUrl, email, password, name, role, databaseUrl, provisioningToken });
console.log(`Provisioned ${result.email} with role ${result.role} (id=${result.id}).`);
