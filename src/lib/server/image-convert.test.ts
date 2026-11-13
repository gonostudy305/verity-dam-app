import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import { optimizeUploadBuffer, replaceExtension } from './image-convert';

test('replaceExtension replaces extension properly', () => {
  assert.equal(replaceExtension('photo.png', '.webp'), 'photo.webp');
  assert.equal(replaceExtension('IMG_5788.HEIC', 'webp'), 'IMG_5788.webp');
  assert.equal(replaceExtension('archive.tar.gz', '.webp'), 'archive.tar.webp');
});

test('optimizeUploadBuffer converts PNG to WebP with same dimensions', async () => {
  const originalPng = await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const result = await optimizeUploadBuffer(originalPng, 'test-image.png', 'image/png');
  assert.equal(result.converted, true);
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.fileName, 'test-image.webp');
  assert.ok(result.sizeBytes > 0);

  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.format, 'webp');
  assert.equal(meta.width, 120);
  assert.equal(meta.height, 80);
});

test('optimizeUploadBuffer passes through WebP untouched', async () => {
  const originalWebp = await sharp({
    create: {
      width: 50,
      height: 50,
      channels: 3,
      background: { r: 0, g: 255, b: 0 },
    },
  })
    .webp()
    .toBuffer();

  const result = await optimizeUploadBuffer(originalWebp, 'icon.webp', 'image/webp');
  assert.equal(result.converted, false);
  assert.equal(result.mimeType, 'image/webp');
  assert.equal(result.fileName, 'icon.webp');
  assert.equal(result.sizeBytes, originalWebp.length);
  assert.deepEqual(result.buffer, originalWebp);
});

test('optimizeUploadBuffer passes through small JPEG untouched', async () => {
  const originalJpeg = await sharp({
    create: {
      width: 60,
      height: 60,
      channels: 3,
      background: { r: 0, g: 0, b: 255 },
    },
  })
    .jpeg()
    .toBuffer();

  const result = await optimizeUploadBuffer(originalJpeg, 'sample.jpg', 'image/jpeg');
  assert.equal(result.converted, false);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.fileName, 'sample.jpg');
  assert.equal(result.sizeBytes, originalJpeg.length);
  assert.deepEqual(result.buffer, originalJpeg);
});

test('optimizeUploadBuffer passes through video unchanged', async () => {
  const fakeVideo = Buffer.from('fake mp4 content');
  const result = await optimizeUploadBuffer(fakeVideo, 'demo.mp4', 'video/mp4');
  assert.equal(result.converted, false);
  assert.equal(result.mimeType, 'video/mp4');
  assert.equal(result.fileName, 'demo.mp4');
  assert.deepEqual(result.buffer, fakeVideo);
});
