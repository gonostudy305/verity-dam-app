import test from 'node:test';
import assert from 'node:assert/strict';

import { assertValidSku } from './product-intakes';

test('assertValidSku: accepts valid SKUs and formats to uppercase with hyphens', () => {
  assert.equal(assertValidSku('XM-SL5MAX'), 'XM-SL5MAX');
  assert.equal(assertValidSku('lf-rf21'), 'LF-RF21');
  assert.equal(assertValidSku('h1 eu'), 'H1-EU');
  assert.equal(assertValidSku('  ac-s02  '), 'AC-S02');
  assert.equal(assertValidSku('PRO_LOCK.V1'), 'PRO_LOCK.V1');
});

test('assertValidSku: rejects SKUs shorter than 3 characters', () => {
  assert.throws(() => assertValidSku('X'), /Mã SKU phải có độ dài tối thiểu 3 ký tự/);
  assert.throws(() => assertValidSku('12'), /Mã SKU phải có độ dài tối thiểu 3 ký tự/);
  assert.throws(() => assertValidSku(''), /Mã SKU phải có độ dài tối thiểu 3 ký tự/);
  assert.throws(() => assertValidSku(null), /Mã SKU phải có độ dài tối thiểu 3 ký tự/);
});

test('assertValidSku: rejects blacklist dummy SKUs', () => {
  assert.throws(() => assertValidSku('test'), /thuộc danh sách mã thử nghiệm bị chặn/);
  assert.throws(() => assertValidSku('TEST'), /thuộc danh sách mã thử nghiệm bị chặn/);
  assert.throws(() => assertValidSku('TEMP'), /thuộc danh sách mã thử nghiệm bị chặn/);
  assert.throws(() => assertValidSku('NONE'), /thuộc danh sách mã thử nghiệm bị chặn/);
  assert.throws(() => assertValidSku('DUMMY'), /thuộc danh sách mã thử nghiệm bị chặn/);
});

test('assertValidSku: rejects invalid characters', () => {
  assert.throws(() => assertValidSku('SKU@#$'), /Mã SKU chỉ được chứa ký tự chữ cái/);
  assert.throws(() => assertValidSku('SKU%20'), /Mã SKU chỉ được chứa ký tự chữ cái/);
});
