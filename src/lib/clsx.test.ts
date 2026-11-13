import assert from 'node:assert/strict';
import test from 'node:test';

import { clsx } from './clsx';

test('clsx joins strings and skips falsy values', () => {
  assert.equal(clsx('a', '', null, undefined, false, 0, 'b'), 'a b');
  assert.equal(clsx(), '');
  assert.equal(clsx(true, 'x'), 'x');
});

test('clsx keeps truthy numbers, drops zero and ignores bigint (as clsx does)', () => {
  assert.equal(clsx(1, 'a', 0, 2), '1 a 2');
  assert.equal(clsx(BigInt(5) as never), '');
});

test('clsx handles conditional expressions like call sites', () => {
  const active = false;
  assert.equal(clsx('base', active ? 'on' : 'off'), 'base off');
  assert.equal(clsx('base', active && 'on'), 'base');
});

test('clsx handles objects, arrays and nesting', () => {
  assert.equal(clsx({ a: true, b: false, c: 1, d: 0, e: 'x', f: '' }), 'a c e');
  assert.equal(clsx(['a', ['b', ['c', null, { d: true }]]], 'e'), 'a b c d e');
  assert.equal(clsx([], {}, [[]]), '');
});
