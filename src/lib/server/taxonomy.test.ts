import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TAXONOMY } from '@/config/taxonomy';
import { asConfig } from './taxonomy';

test('asConfig parses ecosystem facet rows into config.ecosystem', () => {
  const rows = [
    {
      id: '1',
      facet: 'ecosystem' as const,
      value: 'Apple HomeKit',
      label: 'Apple HomeKit',
      sort_order: 10,
      is_active: true,
      updated_by: null,
      updated_at: '2026-09-11T12:00:00Z',
    },
    {
      id: '2',
      facet: 'brand' as const,
      value: 'Acme',
      label: 'Acme',
      sort_order: 10,
      is_active: true,
      updated_by: null,
      updated_at: '2026-09-11T12:00:00Z',
    },
  ];

  const config = asConfig(rows as any, false);
  assert.equal(config.ecosystem.length, 1);
  assert.equal(config.ecosystem[0].value, 'Apple HomeKit');
  assert.equal(config.brand.length, 1);
  assert.equal(config.brand[0].value, 'Acme');
});

test('asConfig defensively skips unknown facets without throwing TypeError', () => {
  const rows = [
    {
      id: '1',
      facet: 'unknown_future_facet' as any,
      value: 'SomeValue',
      label: 'SomeLabel',
      sort_order: 10,
      is_active: true,
      updated_by: null,
      updated_at: '2026-09-11T12:00:00Z',
    },
    {
      id: '2',
      facet: 'brand' as const,
      value: 'Lyra',
      label: 'Lyra',
      sort_order: 10,
      is_active: true,
      updated_by: null,
      updated_at: '2026-09-11T12:00:00Z',
    },
  ];

  // Must not throw TypeError: Cannot read properties of undefined (reading 'push')
  const config = asConfig(rows as any, false);
  assert.equal(config.brand.length, 1);
  assert.equal(config.brand[0].value, 'Lyra');
});

test('DEFAULT_TAXONOMY separates brand and ecosystem', () => {
  const brandValues = DEFAULT_TAXONOMY.brand.map((b) => b.value);
  assert.ok(!brandValues.includes('Tiêu chuẩn A'), 'Ecosystem items must not be in brand facet');
  assert.ok(brandValues.includes('Acme Brand'));

  const ecosystemValues = DEFAULT_TAXONOMY.ecosystem.map((e) => e.value);
  assert.ok(ecosystemValues.includes('Tiêu chuẩn A'), 'Tiêu chuẩn A must be in ecosystem facet');
});
