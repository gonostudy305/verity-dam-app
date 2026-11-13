import test from 'node:test';
import assert from 'node:assert/strict';

import { extractImageCandidates, largestFromSrcset } from './product-image-extract';

const BASE = 'https://shop.example.com/san-pham/den-tha-tran';

test('extractImageCandidates: đọc cả gallery từ JSON-LD Product', () => {
  const html = `
    <html><head>
    <script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"BreadcrumbList","itemListElement":[]},
      {"@type":"Product","name":"Đèn thả trần","image":[
        "https://cdn.example.com/p/hero.jpg",
        {"@type":"ImageObject","url":"https://cdn.example.com/p/angle-2.jpg"},
        "/p/angle-3.jpg"
      ]}
    ]}
    </script>
    </head><body></body></html>`;

  const found = extractImageCandidates(html, BASE);
  assert.deepEqual(
    found.map((entry) => entry.url),
    [
      'https://cdn.example.com/p/hero.jpg',
      'https://cdn.example.com/p/angle-2.jpg',
      'https://shop.example.com/p/angle-3.jpg',
    ]
  );
  assert.ok(found.every((entry) => entry.source === 'jsonld'));
});

test('extractImageCandidates: JSON-LD hỏng không làm chết các tầng sau', () => {
  const html = `
    <script type="application/ld+json">{ this is not json }</script>
    <meta property="og:image" content="https://cdn.example.com/og.jpg">`;

  const found = extractImageCandidates(html, BASE);
  assert.deepEqual(found, [{ url: 'https://cdn.example.com/og.jpg', source: 'meta' }]);
});

test('extractImageCandidates: chỉ có og:image / twitter:image, giải mã &amp;', () => {
  const html = `
    <meta name="twitter:image" content="https://cdn.example.com/tw.jpg">
    <meta property="og:image" content="https://cdn.example.com/og.jpg?w=1200&amp;q=80">`;

  const found = extractImageCandidates(html, BASE);
  assert.deepEqual(
    found.map((entry) => entry.url),
    ['https://cdn.example.com/og.jpg?w=1200&q=80', 'https://cdn.example.com/tw.jpg']
  );
});

test('extractImageCandidates: lấy ứng viên lớn nhất trong srcset và hỗ trợ lazy-load', () => {
  const html = `
    <img srcset="/i/small.jpg 400w, /i/large.jpg 1600w, /i/mid.jpg 800w" src="/i/fallback.jpg">
    <img data-src="/i/lazy.jpg">`;

  const found = extractImageCandidates(html, BASE);
  assert.deepEqual(
    found.map((entry) => entry.url),
    ['https://shop.example.com/i/large.jpg', 'https://shop.example.com/i/lazy.jpg']
  );
  assert.ok(found.every((entry) => entry.source === 'img'));
});

test('extractImageCandidates: loại ảnh giao diện, svg, data URI và URL không http', () => {
  const html = `
    <img src="/assets/logo.png">
    <img src="/assets/icon-cart.svg">
    <img src="/static/placeholder.jpg">
    <img src="data:image/gif;base64,R0lGOD">
    <img src="ftp://cdn.example.com/p/real.jpg">
    <img src="/p/den-tha-tran-1.jpg">`;

  const found = extractImageCandidates(html, BASE);
  assert.deepEqual(
    found.map((entry) => entry.url),
    ['https://shop.example.com/p/den-tha-tran-1.jpg']
  );
});

test('extractImageCandidates: khử trùng lặp và tôn trọng cap số lượng', () => {
  const html = `
    <meta property="og:image" content="https://cdn.example.com/p/hero.jpg">
    <img src="https://cdn.example.com/p/hero.jpg">
    <img src="https://cdn.example.com/p/a.jpg">
    <img src="https://cdn.example.com/p/b.jpg">`;

  const found = extractImageCandidates(html, BASE);
  assert.equal(found.length, 3);
  assert.equal(found[0].source, 'meta'); // nguồn tin cậy hơn thắng khi trùng

  assert.equal(extractImageCandidates(html, BASE, 2).length, 2);
});

test('largestFromSrcset: ưu tiên w lớn nhất, rồi tới mật độ x', () => {
  assert.equal(largestFromSrcset('a.jpg 1x, b.jpg 3x'), 'b.jpg');
  assert.equal(largestFromSrcset('a.jpg 100w, b.jpg 900w'), 'b.jpg');
  assert.equal(largestFromSrcset('only.jpg'), 'only.jpg');
  assert.equal(largestFromSrcset(''), null);
});
