import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SEARCH_CONFIG,
  clearSearchConfigCache,
  loadSearchConfig,
} from './search-config';

test('DEFAULT_SEARCH_CONFIG has all expected default ranking constants', () => {
  assert.equal(DEFAULT_SEARCH_CONFIG.rrf_k, 60);
  assert.equal(DEFAULT_SEARCH_CONFIG.semantic_weight, 1.0);
  assert.equal(DEFAULT_SEARCH_CONFIG.lexical_weight, 1.0);
  assert.equal(DEFAULT_SEARCH_CONFIG.mmr_lambda, 0.7);
  assert.equal(DEFAULT_SEARCH_CONFIG.mmr_pool_size, 40);
  assert.equal(DEFAULT_SEARCH_CONFIG.mmr_output_size, 20);
  assert.equal(DEFAULT_SEARCH_CONFIG.rerank_lexical, 1.0);
  assert.equal(DEFAULT_SEARCH_CONFIG.rerank_fuzzy, 0.5);
  assert.equal(DEFAULT_SEARCH_CONFIG.rerank_rrf, 10.0);
  assert.equal(DEFAULT_SEARCH_CONFIG.rerank_entity, 1.0);
  assert.equal(DEFAULT_SEARCH_CONFIG.semantic_enabled, true);
});

test('loadSearchConfig falls back cleanly to defaults when DB offline or in test env', async () => {
  clearSearchConfigCache();
  const config = await loadSearchConfig();
  assert.equal(config.rrf_k, 60);
  assert.equal(config.semantic_weight, 1.0);
  assert.equal(config.rerank_rrf, 10.0);
  assert.equal(config.mmr_lambda, 0.7);
  assert.equal(config.semantic_enabled, true);
});

test('clearSearchConfigCache resets cached state without error', () => {
  assert.doesNotThrow(() => {
    clearSearchConfigCache();
  });
});
