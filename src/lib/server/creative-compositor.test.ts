import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { composePreservePixels } from './creative-compositor';

test('preserve-pixels compositor produces WebP and reproducible provenance', async () => {
  const background = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#112233' } }).png().toBuffer();
  const product = await sharp({ create: { width: 20, height: 20, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const result = await composePreservePixels({ background, productCutout: product, width: 320, height: 320, productBox: { left: 40, top: 40, width: 200, height: 200 }, productCutoutSha256: createHash('sha256').update(product).digest('hex'), templateVersionId: 'template-v1', compositorVersion: 'v1' });
  assert.equal(result.manifest.compositor_version, 'v1');
  assert.equal(result.manifest.final_output_sha256, result.sha256);
  assert.equal((await sharp(result.image).metadata()).format, 'webp');
});
