import assert from 'node:assert/strict';
import test from 'node:test';

import { hashCreativePayload, normalizeCreativeArticlePayload, planCreativeSlots } from './creative';

const base = {
  external_source: 'blog', external_article_id: 'a-1', external_revision: 'r1',
  brand_version_id: 'brand', channel_version_id: 'channel', title: 'Title',
  thumbnail_template_version_id: 'thumb', section_template_version_id: 'section',
};

test('creative payload hashes are independent of object key order', () => {
  const left = normalizeCreativeArticlePayload({ ...base, source_policy: { max_candidates: 2, order: ['library', 'ai'] } });
  const right = normalizeCreativeArticlePayload({ ...base, source_policy: { order: ['library', 'ai'], max_candidates: 2 } });
  assert.equal(hashCreativePayload(left), hashCreativePayload(right));
});

test('V1 routing policy is server-owned and cannot become AI-first', () => {
  const payload = normalizeCreativeArticlePayload({
    ...base,
    source_policy: { order: ['ai'], max_candidates: 999 },
  });
  assert.deepEqual(payload.source_policy, { order: ['library', 'ai'], max_candidates: 2 });
});

test('deterministic planner always emits thumbnail and caps sections at three', () => {
  const payload = normalizeCreativeArticlePayload({
    ...base,
    max_section_images: 10,
    sections: [
      { id: 'a', heading: 'Short', body: 'x' },
      { id: 'b', heading: 'Product', body: 'x', product_id: 'p-1' },
      { id: 'c', heading: 'Long', body: 'x'.repeat(100) },
      { id: 'd', heading: 'Ignored', body: '' },
    ],
  });
  const slots = planCreativeSlots(payload);
  assert.equal(slots[0].slotKey, 'thumbnail');
  assert.equal(slots.length, 4);
  assert.ok(slots.some((slot) => slot.slotKey === 'section:b'));
});
