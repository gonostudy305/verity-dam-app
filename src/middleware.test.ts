import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

describe('middleware redirect safety', () => {
  const originalTrusted = process.env.VERITY_TRUSTED_ORIGINS;

  it('redirects to tunnel domain when host matches VERITY_TRUSTED_ORIGINS', () => {
    process.env.VERITY_TRUSTED_ORIGINS = 'http://localhost:3000,https://veritydam.example.com';

    const req = new NextRequest('http://127.0.0.1:3000/', {
      headers: {
        'x-forwarded-host': 'veritydam.example.com',
        'x-forwarded-proto': 'https',
      },
    });

    const res = middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.equal(location, 'https://veritydam.example.com/login');
  });

  it('rejects spoofed x-forwarded-host and does not redirect to attacker origin', () => {
    process.env.VERITY_TRUSTED_ORIGINS = 'http://localhost:3000,https://veritydam.example.com';

    const req = new NextRequest('http://127.0.0.1:3000/', {
      headers: {
        'x-forwarded-host': 'evil-phishing.com',
        'x-forwarded-proto': 'https',
      },
    });

    const res = middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.ok(location);
    assert.ok(!location.includes('evil-phishing.com'), 'Must not redirect to spoofed host');
  });

  it('preserves localhost origin when accessed locally', () => {
    process.env.VERITY_TRUSTED_ORIGINS = 'http://localhost:3000,https://veritydam.example.com';

    const req = new NextRequest('http://localhost:3000/');
    const res = middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.equal(location, 'http://localhost:3000/login');
  });

  it('preserves returnUrl on protected routes with safe base origin', () => {
    process.env.VERITY_TRUSTED_ORIGINS = 'http://localhost:3000,https://veritydam.example.com';

    const req = new NextRequest('http://127.0.0.1:3000/library', {
      headers: {
        'x-forwarded-host': 'veritydam.example.com',
        'x-forwarded-proto': 'https',
      },
    });

    const res = middleware(req);
    assert.equal(res.status, 307);
    const location = res.headers.get('location');
    assert.equal(location, 'https://veritydam.example.com/login?returnUrl=%2Flibrary');
  });
});
