import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from './route';

test('GET /api/features returns 200 with product_intakes flag', async () => {
  const original = process.env.VERITY_PRODUCT_INTAKES_ENABLED;
  try {
    process.env.VERITY_PRODUCT_INTAKES_ENABLED = 'false';
    const res1 = await GET();
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.equal(json1.product_intakes, false);

    process.env.VERITY_PRODUCT_INTAKES_ENABLED = 'true';
    const res2 = await GET();
    assert.equal(res2.status, 200);
    const json2 = await res2.json();
    assert.equal(json2.product_intakes, true);
  } finally {
    process.env.VERITY_PRODUCT_INTAKES_ENABLED = original;
  }
});

test('GET /api/features exposes sso_login flag correctly', async () => {
  const res = await GET();
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(typeof json.sso_login, 'boolean');
});
