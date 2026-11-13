import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCreativeTemplateConfig } from './creative-studio-config';

test('creative studio only accepts pinned provider models in immutable template config', () => {
  const config = validateCreativeTemplateConfig({
    prompt: 'Premium editorial scene without text.',
    fidelity_mode: 'reference_generate',
    generation: { provider: 'gemini', model: 'gemini-3.1-flash-image', reserved_minor: 25, currency: 'USD', size: '1024x1024' },
  });
  assert.equal((config.generation as { model: string }).model, 'gemini-3.1-flash-image');
  assert.throws(() => validateCreativeTemplateConfig({ prompt: 'x', generation: { provider: 'openai', model: 'floating', reserved_minor: 1 } }));
});

test('preserve-pixels template cannot be saved without deterministic compositor layout', () => {
  assert.throws(() => validateCreativeTemplateConfig({
    prompt: 'Background only.', fidelity_mode: 'preserve_pixels',
    generation: { provider: 'openai', model: 'gpt-image-2.5-sunburst-2026-09-08', reserved_minor: 5, currency: 'USD' },
  }));
});
