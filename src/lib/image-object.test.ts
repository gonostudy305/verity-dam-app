import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanonicalImageObject,
  escapeHtmlAttribute,
  safeJsonLd,
} from './image-object';

test('escapeHtmlAttribute properly escapes dangerous HTML characters', () => {
  assert.equal(
    escapeHtmlAttribute('<img src="test.jpg" alt=\'hello & goodbye\'>'),
    '&lt;img src=&quot;test.jpg&quot; alt=&#39;hello &amp; goodbye&#39;&gt;'
  );
  assert.equal(escapeHtmlAttribute(1200), '1200');
  assert.equal(escapeHtmlAttribute(null), '');
  assert.equal(escapeHtmlAttribute(undefined), '');
});

test('safeJsonLd prevents script tag breakout by escaping < to \\u003c', () => {
  const payload = {
    title: '</script><script>alert("xss")</script>',
    url: 'https://assets.verity.internal/photo.webp',
  };
  const serialized = safeJsonLd(payload);
  assert.equal(serialized.includes('</script>'), false);
  assert.equal(serialized.includes('\\u003c/script>'), true);
});

test('buildCanonicalImageObject defaults Verity author to Organization', () => {
  const obj1 = buildCanonicalImageObject({
    contentUrl: 'https://assets.verity.internal/sample.webp',
    width: 800,
    height: 600,
    title: 'Smart Lock',
    author: 'VerityDAM Platform',
  });
  assert.deepEqual(obj1.creator, {
    '@type': 'Organization',
    name: 'VerityDAM Platform',
  });
  assert.equal(obj1.creditText, 'VerityDAM Platform');
  // License fields omitted by default to avoid unverified 404 targets
  assert.equal(obj1.license, undefined);
  assert.equal(obj1.acquireLicensePage, undefined);

  // Empty author should also default to Verity Organization
  const obj2 = buildCanonicalImageObject({
    contentUrl: 'https://assets.verity.internal/sample.webp',
    width: 800,
    height: 600,
    title: 'Smart Lock',
    author: '   ',
  });
  assert.deepEqual(obj2.creator, {
    '@type': 'Organization',
    name: 'VerityDAM Platform',
  });
});

test('buildCanonicalImageObject assigns custom non-Verity author to Person via heuristic', () => {
  const obj = buildCanonicalImageObject({
    contentUrl: 'https://assets.verity.internal/sample.webp',
    width: 800,
    height: 600,
    title: 'Smart Lock',
    author: 'Tran Van Bao',
    credit: 'Tran Van Bao Photography',
    license: 'https://veritydam.example/verified-license',
    acquireLicensePage: 'https://veritydam.example/contact-license',
  });
  assert.deepEqual(obj.creator, {
    '@type': 'Person',
    name: 'Tran Van Bao',
  });
  assert.equal(obj.creditText, 'Tran Van Bao Photography');
  assert.equal(obj.license, 'https://veritydam.example/verified-license');
  assert.equal(obj.acquireLicensePage, 'https://veritydam.example/contact-license');
});
