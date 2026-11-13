import assert from 'node:assert/strict';
import test from 'node:test';
import { canNavigate, getNavigationItems } from './navigation';

const viewer = { email: 'viewer@example.test', role: 'viewer' };
const contributor = { email: 'contributor@example.test', role: 'contributor' };
const reviewer = { email: 'reviewer@example.test', role: 'reviewer' };
const admin = { email: 'admin@example.test', role: 'admin' };

test('navigation keeps the core library available and filters privileged routes by role', () => {
  assert.deepEqual(
    getNavigationItems(4, viewer).map((item) => item.href),
    ['/library', '/studio']
  );
  assert.deepEqual(
    getNavigationItems(4, contributor).map((item) => item.href),
    ['/library', '/upload', '/product-intakes', '/studio', '/shot']
  );
  assert.equal(getNavigationItems(4, reviewer).find((item) => item.href === '/review')?.badge, 4);
  assert.equal(getNavigationItems(4, reviewer, 7).find((item) => item.href === '/duplicates')?.badge, 7);
  assert.equal(getNavigationItems(4, reviewer, 7, 3).find((item) => item.href === '/reports')?.badge, 3);
  assert.ok(getNavigationItems(4, viewer, 7, 3).every((item) => item.href !== '/duplicates' && item.href !== '/reports'));
  assert.ok(getNavigationItems(4, admin).some((item) => item.href === '/settings'));
});

test('navigation marks library, review, upload and product-intakes as primary destinations', () => {
  const items = getNavigationItems(0, reviewer);
  assert.deepEqual(items.filter((item) => item.primary).map((item) => item.href), ['/library', '/review', '/upload', '/product-intakes']);
  assert.deepEqual(items.filter((item) => !item.primary).map((item) => item.href), ['/duplicates', '/reports', '/studio', '/shot']);
});

test('navigation hides product-intakes when the feature flag is off', () => {
  assert.deepEqual(
    getNavigationItems(0, contributor, 0, 0, false).map((item) => item.href),
    ['/library', '/upload', '/studio', '/shot']
  );
});

test('navigation fails closed for privileged links while session state is loading', () => {
  assert.equal(canNavigate({ href: '/settings', label: 'Cài đặt', icon: getNavigationItems()[0].icon, minimumRole: 'admin' }, null), false);
  assert.deepEqual(getNavigationItems(4, null).map((item) => item.href), ['/library', '/studio']);
});
