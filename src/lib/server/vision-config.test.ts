import assert from 'node:assert/strict';
import test from 'node:test';

import {
  visionConfigDefaults,
  getSharedVisionConfig,
  saveSharedVisionConfig,
} from './vision-config';

test('visionConfigDefaults defines production defaults for vision AI', () => {
  assert.equal(visionConfigDefaults.baseUrl, 'https://api.example.com/v1');
  assert.equal(visionConfigDefaults.model, 'cx/gpt-6-luna');
  assert.equal(visionConfigDefaults.detail, 'high');
  assert.equal(visionConfigDefaults.maxTokens, 1000);
  assert.ok(visionConfigDefaults.systemPrompt.includes('Vietnamese captions'));
});

test('saveSharedVisionConfig rejects invalid baseUrl or protocol', async () => {
  await assert.rejects(
    async () => {
      await saveSharedVisionConfig({
        baseUrl: 'http://insecure.example.com/v1',
        model: 'cx/gpt-6-luna',
        detail: 'high',
        maxTokens: 1000,
        systemPrompt: 'System prompt test',
        apiKey: 'sk-test-valid-length-key-12345',
      });
    },
    { message: 'Vision base URL must be HTTPS without credentials or query strings.' }
  );
});

test('saveSharedVisionConfig rejects invalid token range', async () => {
  await assert.rejects(
    async () => {
      await saveSharedVisionConfig({
        baseUrl: 'https://api.example.com/v1',
        model: 'cx/gpt-6-luna',
        detail: 'high',
        maxTokens: 100, // below 256
        systemPrompt: 'System prompt test',
        apiKey: 'sk-test-valid-length-key-12345',
      });
    },
    { message: 'Vision max tokens must be between 256 and 4096.' }
  );
});

test('saveSharedVisionConfig rejects empty API key when no config exists', async () => {
  await assert.rejects(
    async () => {
      await saveSharedVisionConfig({
        baseUrl: 'https://api.example.com/v1',
        model: 'cx/gpt-6-luna',
        detail: 'high',
        maxTokens: 1000,
        systemPrompt: 'System prompt test',
      });
    },
    (err: unknown) => {
      const error = err as { code?: string; message?: string };
      return (
        error.code === 'VISION_API_KEY_REQUIRED' ||
        error.code === 'VISION_CONFIG_STORE_UNAVAILABLE'
      );
    }
  );
});
