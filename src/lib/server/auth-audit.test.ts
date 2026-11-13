import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authAuditEmailFromBody,
  authAuditFailureCode,
  authAuditRequestDetails,
  authAuditResponseStatus,
  normalizeAuditEmail,
} from './auth-audit';

test('auth audit normalizes and bounds email values', () => {
  assert.equal(normalizeAuditEmail('  USER@veritydam.example '), 'user@veritydam.example');
  assert.equal(normalizeAuditEmail(''), null);
  assert.equal(normalizeAuditEmail(42), null);
  assert.equal(normalizeAuditEmail(`A${'x'.repeat(400)}@veritydam.example`)?.length, 320);
});

test('auth audit extracts only the email field from a request body', () => {
  assert.equal(authAuditEmailFromBody({ email: ' Reviewer@veritydam.example ', password: 'must-not-be-stored' }), 'reviewer@veritydam.example');
  assert.equal(authAuditEmailFromBody({ password: 'no email' }), null);
  assert.equal(authAuditEmailFromBody(null), null);
});

test('auth audit resolves proxy address, user agent, and Better Auth path', () => {
  const details = authAuditRequestDetails({
    path: '/sign-in/email',
    headers: new Headers({
      'x-forwarded-for': '203.0.113.10, 10.0.0.4',
      'user-agent': 'Verity Test Browser',
    }),
  });
  assert.deepEqual(details, {
    ipAddress: '203.0.113.10',
    userAgent: 'Verity Test Browser',
    requestPath: '/sign-in/email',
  });
});

test('auth audit reads response and API error statuses without leaking payloads', () => {
  assert.equal(authAuditResponseStatus(new Response(null, { status: 401 })), 401);
  assert.equal(authAuditResponseStatus({ statusCode: 403, body: { password: 'secret' } }), 403);
  assert.equal(authAuditFailureCode({ errorCode: 'INVALID_EMAIL_OR_PASSWORD', password: 'secret' }), 'INVALID_EMAIL_OR_PASSWORD');
  assert.equal(authAuditFailureCode({ statusCode: 401 }), '401');
  assert.equal(authAuditFailureCode({ password: 'secret' }), null);
});

