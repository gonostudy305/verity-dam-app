import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSkuContext,
  isSkuNagSuppressed,
  isAutoPromotable,
} from './sku-context';

test('resolveSkuContext: Studio resolves to product', () => {
  assert.equal(resolveSkuContext({ category: 'Studio' }), 'product');
  assert.equal(resolveSkuContext({ category: 'studio' }), 'product');
  assert.equal(resolveSkuContext({ category: '  Studio  ' }), 'product');
});

test('resolveSkuContext: Banner resolves to marketing', () => {
  assert.equal(resolveSkuContext({ category: 'Banner' }), 'marketing');
  assert.equal(resolveSkuContext({ category: 'banner' }), 'marketing');
  assert.equal(resolveSkuContext({ category: '  banner  ' }), 'marketing');
});

test('resolveSkuContext: non_catalog override wins over category', () => {
  assert.equal(resolveSkuContext({ category: 'Studio', non_catalog: true }), 'scene');
  assert.equal(resolveSkuContext({ category: 'Banner', non_catalog: true }), 'scene');
  assert.equal(resolveSkuContext({ category: 'Công trình', non_catalog: true }), 'scene');
});

test('resolveSkuContext: fail-closed default for all other categories and nulls', () => {
  // Known scene categories
  assert.equal(resolveSkuContext({ category: 'Công trình' }), 'scene');
  assert.equal(resolveSkuContext({ category: 'Showroom' }), 'scene');
  assert.equal(resolveSkuContext({ category: 'Bảo hành' }), 'scene');

  // Empty / null / undefined / unknown categories
  assert.equal(resolveSkuContext({ category: null }), 'scene');
  assert.equal(resolveSkuContext({ category: undefined }), 'scene');
  assert.equal(resolveSkuContext({ category: '' }), 'scene');
  assert.equal(resolveSkuContext({ category: '   ' }), 'scene');
  assert.equal(resolveSkuContext({ category: 'UnknownCustomCategory' }), 'scene');
});

test('isSkuNagSuppressed: suppressed for scene and marketing, active only for product', () => {
  assert.equal(isSkuNagSuppressed('product'), false);
  assert.equal(isSkuNagSuppressed('scene'), true);
  assert.equal(isSkuNagSuppressed('marketing'), true);
});

test('isAutoPromotable: true only for product', () => {
  assert.equal(isAutoPromotable('product'), true);
  assert.equal(isAutoPromotable('scene'), false);
  assert.equal(isAutoPromotable('marketing'), false);
});
