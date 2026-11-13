import { Client } from 'pg';

export async function provisionBetterAuthAccount({ baseUrl, email, password, name, role, databaseUrl, provisioningToken }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': baseUrl,
      'x-verity-provisioning-token': provisioningToken,
    },
    body: JSON.stringify({ name, email, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 400) {
    throw new Error(`Better Auth sign-up failed with HTTP ${response.status}: ${body?.message || 'unknown error'}`);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      'update public."user" set role = $1, "updatedAt" = now() where lower(email) = lower($2) returning id, email, role',
      [role, email],
    );
    if (!result.rows[0]) throw new Error('User was not found after sign-up; inspect the Better Auth response and database.');
    return result.rows[0];
  } finally {
    await client.end();
  }
}
