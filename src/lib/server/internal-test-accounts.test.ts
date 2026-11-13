import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getConfiguredInternalTestAccounts,
  getInternalTestAccountCredentials,
  isInternalTestAccountsEnabled,
} from './internal-test-accounts';

const ENV_KEYS = [
  'NODE_ENV',
  'VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED',
  'VERITY_INTERNAL_TEST_VIEWER_EMAIL',
  'VERITY_INTERNAL_TEST_VIEWER_PASSWORD',
  'VERITY_INTERNAL_TEST_VIEWER_NAME',
  'VERITY_INTERNAL_TEST_CONTRIBUTOR_EMAIL',
  'VERITY_INTERNAL_TEST_CONTRIBUTOR_PASSWORD',
  'VERITY_INTERNAL_TEST_CONTRIBUTOR_NAME',
  'VERITY_INTERNAL_TEST_REVIEWER_EMAIL',
  'VERITY_INTERNAL_TEST_REVIEWER_PASSWORD',
  'VERITY_INTERNAL_TEST_REVIEWER_NAME',
  'VERITY_INTERNAL_TEST_ADMIN_EMAIL',
  'VERITY_INTERNAL_TEST_ADMIN_PASSWORD',
  'VERITY_INTERNAL_TEST_ADMIN_NAME',
];

function withTestEnvironment(callback: () => void): void {
  const env = process.env as Record<string, string | undefined>;
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    env.NODE_ENV = 'test';
    process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED = 'true';
    for (const role of ['viewer', 'contributor', 'reviewer', 'admin']) {
      const upper = role.toUpperCase();
      process.env[`VERITY_INTERNAL_TEST_${upper}_EMAIL`] = `system-${role}@example.invalid`;
      process.env[`VERITY_INTERNAL_TEST_${upper}_PASSWORD`] = `test-${role}-password`;
      process.env[`VERITY_INTERNAL_TEST_${upper}_NAME`] = `System ${role}`;
    }
    callback();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('internal test accounts expose all configured roles without passwords', () => {
  withTestEnvironment(() => {
    assert.equal(isInternalTestAccountsEnabled(), true);
    const accounts = getConfiguredInternalTestAccounts();
    assert.deepEqual(accounts.map((account) => account.role), ['viewer', 'contributor', 'reviewer', 'admin']);
    assert.equal('password' in accounts[0], false);
    assert.equal(getInternalTestAccountCredentials('system-reviewer')?.email, 'system-reviewer@example.invalid');
  });
});

test('internal test accounts are disabled in production even when the flag is set', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFlag = process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED;
  try {
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = 'production';
    process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED = 'true';
    assert.equal(isInternalTestAccountsEnabled(), false);
    assert.deepEqual(getConfiguredInternalTestAccounts(), []);
    assert.equal(getInternalTestAccountCredentials('system-admin'), null);
  } finally {
    const env = process.env as Record<string, string | undefined>;
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
    if (previousFlag === undefined) delete process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED;
    else process.env.VERITY_INTERNAL_TEST_ACCOUNTS_ENABLED = previousFlag;
  }
});
