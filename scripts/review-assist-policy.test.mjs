import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReviewCandidate, validateApprovalPayload } from './review-assist-policy.mjs';

function item(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    status: 'pending',
    is_duplicate: false,
    duplicate_similarity: 0,
    duplicate_matches: [],
    sku_match: {
      source: 'embedding_reference',
      sku: 'IPC-A32P-PRO',
      confidence_band: 'high',
      similarity: 0.96,
      margin: 0.14,
      requires_reviewer_confirmation: false,
      ambiguity_warning: false,
      candidates: [{ sku: 'IPC-A32P-PRO', similarity: 0.96 }],
      catalog_identity: {
        brand: 'Imex',
        model_name: 'A32P Pro',
        display_name: 'Imex IPC-A32P-PRO',
        catalog_sku_kind: 'machine_code',
      },
    },
    asset: {
      id: '00000000-0000-4000-8000-000000000002',
      title: 'A32P Pro',
      sku: 'IPC-A32P-PRO',
      brand: 'Imex',
      category: 'Studio',
      space: 'Studio',
      status: 'Mới',
      permission: 'internal',
      media_type: 'photo',
      ingest_status: 'ready',
      file_url: '/api/r2-proxy?key=asset.webp',
      thumbnail_url: '/api/r2-proxy?key=thumb.webp',
      dimensions: { width: 1200, height: 800 },
      ai_flags: { has_people: false, is_ai: false, is_broken: false, tag_failed: false, non_catalog: false },
      needs_post_production: false,
    },
    ...overrides,
  };
}

test('accepts only a fully explicit high-confidence catalog candidate', () => {
  const result = evaluateReviewCandidate(item(), {
    checked: true,
    ok: true,
    decoded: true,
    width: 1200,
    height: 800,
  });
  assert.equal(result.eligible, true);
  assert.deepEqual(result.blockers, []);
});

test('fails closed when the image is unreadable or the SKU is ambiguous', () => {
  const candidate = item({ sku_match: { ...item().sku_match, ambiguity_warning: true } });
  const result = evaluateReviewCandidate(candidate, { checked: true, ok: false, decoded: false, error: 'HTTP 502' });
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'IMAGE_FETCH_FAILED'));
  assert.ok(result.blockers.some((blocker) => blocker.code === 'SKU_AMBIGUOUS'));
});

test('blocks people, duplicates and non-catalog assets', () => {
  const candidate = item({
    is_duplicate: true,
    duplicate_similarity: 0.94,
    asset: { ...item().asset, ai_flags: { ...item().asset.ai_flags, has_people: true, non_catalog: true } },
  });
  const result = evaluateReviewCandidate(candidate, { checked: true, ok: true, decoded: true, width: 1200, height: 800 });
  assert.equal(result.eligible, false);
  for (const code of ['DUPLICATE_FLAGGED', 'PEOPLE_DETECTED', 'NON_CATALOG_ASSET']) {
    assert.ok(result.blockers.some((blocker) => blocker.code === code));
  }
});

test('blocks an asset with an open report even when the SKU signal is strong', () => {
  const candidate = item({ asset: { ...item().asset, has_open_report: true } });
  const result = evaluateReviewCandidate(candidate, { checked: true, ok: true, decoded: true, width: 1200, height: 800 });
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'OPEN_ASSET_REPORT'));
});

test('blocks UI payloads that change metadata or create learning side effects', () => {
  const baseline = item();
  const result = validateApprovalPayload({
    decision: 'approved',
    patch: { sku: 'OTHER-SKU', brand: 'Imex' },
    corrections: ['sku'],
    promote_reference: true,
  }, baseline, { confirmed_sku: baseline.asset.sku });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('UNEXPECTED_PATCH_SKU'));
  assert.ok(result.blockers.includes('CORRECTIONS_NOT_ALLOWED'));
  assert.ok(result.blockers.includes('REFERENCE_PROMOTION_NOT_ALLOWED'));
});

test('allows an unchanged approval payload only', () => {
  const baseline = item();
  const result = validateApprovalPayload({
    decision: 'approved',
    patch: { sku: baseline.asset.sku, brand: baseline.asset.brand, keywords: [] },
    corrections: [],
    non_catalog: false,
    promote_reference: false,
    needs_post_production: false,
  }, baseline, { confirmed_sku: baseline.asset.sku });
  assert.equal(result.ok, true);
});

test('blocks patch keys outside the reviewed asset form contract', () => {
  const baseline = item();
  const result = validateApprovalPayload({
    decision: 'approved',
    patch: { review_state: 'approved' },
  }, baseline, { confirmed_sku: baseline.asset.sku });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('UNKNOWN_PATCH_KEY_REVIEW_STATE'));
});

test('does not allow a decision manifest to whitelist metadata changes', () => {
  const baseline = item();
  const result = validateApprovalPayload({
    decision: 'approved',
    patch: { title: 'Different title' },
  }, baseline, {
    confirmed_sku: baseline.asset.sku,
    allowed_patch: { title: 'Different title' },
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('ALLOWED_PATCH_NOT_PERMITTED'));
  assert.ok(result.blockers.includes('UNEXPECTED_PATCH_TITLE'));
});
