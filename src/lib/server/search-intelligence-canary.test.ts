import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANARY_PERCENT_ENV,
  getSearchCanaryPercent,
  isUserInCanary,
  shouldServeCanaryIntelligence,
} from './search-intelligence-canary';

test('isUserInCanary: fail-closed at 0% and total at 100%', () => {
  assert.equal(isUserInCanary('any-user', 0), false);
  assert.equal(isUserInCanary('any-user', -5), false);
  assert.equal(isUserInCanary('any-user', 100), true);
  assert.equal(isUserInCanary('any-user', 150), true);
});

test('isUserInCanary: empty/whitespace identifier is never in canary (fail-closed)', () => {
  assert.equal(isUserInCanary('', 50), false);
  assert.equal(isUserInCanary('   ', 50), false);
  // @ts-expect-error runtime robustness against non-string identifiers
  assert.equal(isUserInCanary(undefined, 50), false);
});

test('isUserInCanary: deterministic for the same identifier + percent', () => {
  const a = isUserInCanary('demo.user@example.com', 25);
  const b = isUserInCanary('demo.user@example.com', 25);
  assert.equal(a, b);
});

test('isUserInCanary: membership is monotonic as percent increases', () => {
  // A user included at a lower percentage must remain included at higher ones,
  // because the test is `hash % 100 < percent`.
  for (let i = 0; i < 500; i++) {
    const id = `user-${i}`;
    if (isUserInCanary(id, 5)) {
      assert.equal(isUserInCanary(id, 25), true, `${id} dropped out between 5% and 25%`);
      assert.equal(isUserInCanary(id, 100), true, `${id} dropped out between 25% and 100%`);
    }
  }
});

test('isUserInCanary: deterministic bucket distribution within +/-1% of target over 20k IDs', () => {
  const N = 20_000;
  for (const pct of [5, 25, 50]) {
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (isUserInCanary(`synthetic-id-${i}`, pct)) hits++;
    }
    const observed = (hits / N) * 100;
    assert.ok(
      Math.abs(observed - pct) <= 1,
      `target ${pct}% but observed ${observed.toFixed(3)}% over ${N} deterministic IDs`,
    );
  }
});

test('getSearchCanaryPercent: default 0 and fail-closed on invalid config', () => {
  assert.equal(getSearchCanaryPercent({}), 0);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '' }), 0);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: 'abc' }), 0);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: 'NaN' }), 0);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '-10' }), 0);
});

test('getSearchCanaryPercent: parses, floors, and clamps to [0,100]', () => {
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '5' }), 5);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '25' }), 25);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '5.9' }), 5);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '100' }), 100);
  assert.equal(getSearchCanaryPercent({ [CANARY_PERCENT_ENV]: '250' }), 100);
});

test('shouldServeCanaryIntelligence: false by default (no env), true only when configured + bucketed', () => {
  // Default env with no canary percent -> always baseline.
  assert.equal(shouldServeCanaryIntelligence('user-1', {}), false);
  // 100% -> everyone served intelligence.
  assert.equal(shouldServeCanaryIntelligence('user-1', { [CANARY_PERCENT_ENV]: '100' }), true);
  // Consistent with the primitive at a mid percentage.
  const pct = 25;
  assert.equal(
    shouldServeCanaryIntelligence('user-42', { [CANARY_PERCENT_ENV]: String(pct) }),
    isUserInCanary('user-42', pct),
  );
});
