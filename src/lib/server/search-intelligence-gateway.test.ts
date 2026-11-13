import assert from 'node:assert/strict';
import test from 'node:test';

import { isSearchIntelligenceV1Enabled, isSearchShadowV1Enabled } from './search-intelligence-flag';
import { runSearchIntelligenceGateway } from './search-intelligence-gateway';

test('flag defaults to false when env var is unset', () => {
  assert.equal(isSearchIntelligenceV1Enabled({}), false);
  assert.equal(isSearchShadowV1Enabled({}), false);
});

test('flag is false for any value other than the literal string true', () => {
  assert.equal(isSearchIntelligenceV1Enabled({ VERITY_SEARCH_INTELLIGENCE_V1_ENABLED: 'false' }), false);
  assert.equal(isSearchIntelligenceV1Enabled({ VERITY_SEARCH_INTELLIGENCE_V1_ENABLED: '1' }), false);
  assert.equal(isSearchIntelligenceV1Enabled({ VERITY_SEARCH_INTELLIGENCE_V1_ENABLED: 'TRUE' }), false);

  assert.equal(isSearchShadowV1Enabled({ VERITY_SEARCH_SHADOW_V1_ENABLED: 'false' }), false);
  assert.equal(isSearchShadowV1Enabled({ VERITY_SEARCH_SHADOW_V1_ENABLED: '1' }), false);
  assert.equal(isSearchShadowV1Enabled({ VERITY_SEARCH_SHADOW_V1_ENABLED: 'TRUE' }), false);
});

test('flag is true only for the literal string true', () => {
  assert.equal(isSearchIntelligenceV1Enabled({ VERITY_SEARCH_INTELLIGENCE_V1_ENABLED: 'true' }), true);
  assert.equal(isSearchShadowV1Enabled({ VERITY_SEARCH_SHADOW_V1_ENABLED: 'true' }), true);
});

test('Part 14: flag-false output is behaviorally equivalent to baseline output', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a', 'b'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    intelligence: () => ({ source: 'INTELLIGENCE', items: ['x'] }),
    isEnabled: () => false,
  });
  assert.deepEqual(result, baselineResult);
});

test('no intelligence function supplied falls back to baseline even if flag is true', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    isEnabled: () => true,
  });
  assert.deepEqual(result, baselineResult);
});

test('flag true and intelligence succeeds returns the intelligence result', async () => {
  const intelligenceResult = { source: 'INTELLIGENCE', items: ['x', 'y'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => ({ source: 'BASELINE_L0', items: ['a'] }),
    intelligence: () => intelligenceResult,
    isEnabled: () => true,
  });
  assert.deepEqual(result, intelligenceResult);
});

test('Part 15: intelligence throwing synchronously falls back to baseline without throwing', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    intelligence: () => {
      throw new Error('intelligence path exploded');
    },
    isEnabled: () => true,
  });
  assert.deepEqual(result, baselineResult);
});

test('Part 15: intelligence rejecting asynchronously falls back to baseline without throwing', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    intelligence: async () => {
      throw new Error('async intelligence path exploded');
    },
    isEnabled: () => true,
  });
  assert.deepEqual(result, baselineResult);
});

test('shadow hook: called with baseline result when intelligence is not enabled', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a', 'b'] };
  let shadowReceived: unknown = null;
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    isEnabled: () => false,
    shadow: (res) => {
      shadowReceived = res;
    },
  });
  assert.deepEqual(result, baselineResult);
  assert.deepEqual(shadowReceived, baselineResult);
});

test('shadow hook: not called when intelligence is enabled and succeeds', async () => {
  const intelligenceResult = { source: 'INTELLIGENCE', items: ['x'] };
  let shadowCalled = false;
  const result = await runSearchIntelligenceGateway({
    baseline: () => ({ source: 'BASELINE_L0', items: ['a'] }),
    intelligence: () => intelligenceResult,
    isEnabled: () => true,
    shadow: () => {
      shadowCalled = true;
    },
  });
  assert.deepEqual(result, intelligenceResult);
  assert.equal(shadowCalled, false);
});

test('shadow hook: synchronous throw is swallowed and does not affect baseline', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    isEnabled: () => false,
    shadow: () => {
      throw new Error('shadow sync error');
    },
  });
  assert.deepEqual(result, baselineResult);
});

test('shadow hook: async rejection is swallowed and does not affect baseline', async () => {
  const baselineResult = { source: 'BASELINE_L0', items: ['a'] };
  const result = await runSearchIntelligenceGateway({
    baseline: () => baselineResult,
    isEnabled: () => false,
    shadow: async () => {
      throw new Error('shadow async error');
    },
  });
  assert.deepEqual(result, baselineResult);
});
