import assert from 'node:assert/strict';
import test from 'node:test';

import { isProvisioningTokenValid, isSignUpPath } from './auth-provisioning';

test('provisioning token validation fails closed and uses exact matching', () => {
  assert.equal(isProvisioningTokenValid(null, 'secret'), false);
  assert.equal(isProvisioningTokenValid('secret', undefined), false);
  assert.equal(isProvisioningTokenValid('secret', 'secret'), true);
  assert.equal(isProvisioningTokenValid('secret', 'SECRET'), false);
  assert.equal(isProvisioningTokenValid('secret-extra', 'secret'), false);
});

test('isSignUpPath matches email sign up endpoints with or without trailing slash', () => {
  assert.equal(isSignUpPath('/api/auth/sign-up/email'), true);
  assert.equal(isSignUpPath('/api/auth/sign-up/email/'), true);
  assert.equal(isSignUpPath('/api/auth/sign-up'), true);
  assert.equal(isSignUpPath('/api/auth/sign-up/'), true);
  assert.equal(isSignUpPath('/api/auth/sign-in/email'), false);
  assert.equal(isSignUpPath('/api/auth/session'), false);
  assert.equal(isSignUpPath('/login'), false);
});
