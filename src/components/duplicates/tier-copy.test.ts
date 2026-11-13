import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_COPY, tierLabel } from './tier-copy';

test('duplicate tier copy uses the fixed Vietnamese workbench labels', () => {
  assert.equal(tierLabel('exact'), 'TRÙNG CHÍNH XÁC');
  assert.equal(tierLabel('near'), 'RẤT CÓ THỂ TRÙNG');
  assert.equal(tierLabel('similar'), 'ẢNH TƯƠNG TỰ');
  assert.match(TIER_COPY.similar.description, /không tự coi là trùng/);
});
