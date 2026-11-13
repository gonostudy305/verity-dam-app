import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIlikeTermCondition, buildEligibilityWhere } from './native-media';
import type { MediaListParams } from '@/lib/media-api';

function mkParams(overrides: Partial<MediaListParams> = {}): MediaListParams {
  return {
    query: '',
    category: [],
    space: [],
    status: [],
    permission: [],
    source: [],
    mediaType: [],
    onlyAi: false,
    onlyPeople: false,
    onlyInternal: false,
    sort: 'newest',
    page: 1,
    pageSize: 24,
    ...overrides,
  };
}

test('buildIlikeTermCondition pushes both wildcard and raw term parameters', () => {
  const values: unknown[] = [];
  const condition = buildIlikeTermCondition('Verity-100', values);

  assert.equal(values.length, 2);
  assert.equal(values[0], '%Verity-100%');
  assert.equal(values[1], 'Verity-100');

  // Confirms index bindings $1 and $2
  assert.ok(condition.includes('a.title ilike $1 escape \'\\\''));
  assert.ok(condition.includes('lower(p.primary_sku) = lower($2)'));
  assert.ok(condition.includes('lower(p.code) = lower($2)'));
  assert.ok(condition.includes('lower(p.model_name) = lower($2)'));
  assert.ok(condition.includes("mp.review_state = 'confirmed'"));
});

test('buildIlikeTermCondition advances parameter indexes across consecutive calls', () => {
  const values: unknown[] = ['pre-existing-val'];
  const cond1 = buildIlikeTermCondition('SKU-1', values);
  const cond2 = buildIlikeTermCondition('SKU-2', values);

  assert.equal(values.length, 5);
  assert.equal(values[1], '%SKU-1%');
  assert.equal(values[2], 'SKU-1');
  assert.equal(values[3], '%SKU-2%');
  assert.equal(values[4], 'SKU-2');

  assert.ok(cond1.includes('$2'));
  assert.ok(cond1.includes('$3'));
  assert.ok(cond2.includes('$4'));
  assert.ok(cond2.includes('$5'));
});

test('media_asset_products join enforces confirmed review_state only', () => {
  const values: unknown[] = [];
  const condition = buildIlikeTermCondition('SECONDARY-SKU', values);

  // Must check mp.review_state = 'confirmed' (draft/rejected do not create recall)
  assert.ok(condition.includes("mp.review_state = 'confirmed'"));
  assert.ok(!condition.includes("mp.review_state = 'draft'"));
  assert.ok(!condition.includes("mp.review_state = 'rejected'"));
});

test('soft-deleted assets remain excluded by eligibility where even if secondary SKU matches', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams({ query: 'Verity-100' }), values);

  // Soft delete invariant: a.deleted_at is null is always present
  assert.ok(eligibility.some((clause) => clause.includes('a.deleted_at is null')));
});

test('buildEligibilityWhere: options.excludeReported adds NOT EXISTS subquery for open reports', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams(), values, { excludeReported: true });

  assert.ok(
    eligibility.some((clause) =>
      clause.includes("not exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))")
    )
  );
});

test('buildEligibilityWhere: default options do NOT add NOT EXISTS subquery', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams(), values, {});

  assert.ok(
    !eligibility.some((clause) => clause.includes('not exists (select 1 from public.asset_reports'))
  );
});

test('buildEligibilityWhere: params.onlyReported adds EXISTS subquery for open reports', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams({ onlyReported: true }), values, {});

  assert.ok(
    eligibility.some((clause) =>
      clause.includes("exists (select 1 from public.asset_reports r where r.media_asset_id = a.id and r.status in ('open','in_review'))")
    )
  );
});

test('buildEligibilityWhere: options.excludeUnfinished adds needs_post_production = false', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams(), values, { excludeUnfinished: true });

  assert.ok(eligibility.some((clause) => clause.includes('a.needs_post_production = false')));
});

test('buildEligibilityWhere: default options do NOT add the needs_post_production exclusion', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams(), values, {});

  assert.ok(!eligibility.some((clause) => clause.includes('needs_post_production')));
});

test('buildEligibilityWhere: excludeUnfinished does not add a permission filter (internal assets stay reachable)', () => {
  const values: unknown[] = [];
  const eligibility = buildEligibilityWhere(mkParams(), values, { excludeUnfinished: true, canSeeInternal: true });

  assert.ok(!eligibility.some((clause) => clause.includes("a.permission <>")));
});
