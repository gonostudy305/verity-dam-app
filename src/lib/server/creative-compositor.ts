import { createHash } from 'node:crypto';
import sharp, { type OverlayOptions } from 'sharp';

import { ApiError } from './http';

export type PreservePixelsInput = {
  background: Buffer; productCutout: Buffer; logo?: Buffer; width: number; height: number;
  productBox: { left: number; top: number; width: number; height: number };
  logoBox?: { left: number; top: number; width: number; height: number };
  headline?: string; headlineBox?: { left: number; top: number; width: number; height: number };
  productCutoutSha256: string; logoSha256?: string; fontSha256?: string;
  templateVersionId: string; compositorVersion: string;
};
export type PreservePixelsResult = { image: Buffer; sha256: string; manifest: Record<string, unknown> };

function assertBox(value: { left: number; top: number; width: number; height: number }, width: number, height: number, name: string) {
  if ([value.left, value.top, value.width, value.height].some((number) => !Number.isInteger(number)) || value.width < 1 || value.height < 1 || value.left < 0 || value.top < 0 || value.left + value.width > width || value.top + value.height > height) throw new ApiError(400, 'INVALID_COMPOSITOR_LAYOUT', `${name} vượt ngoài canvas.`);
}
function esc(value: string) { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character] || character)); }

/** The final preserve_pixels stage: precomputed raster layers only, never a model call. */
export async function composePreservePixels(input: PreservePixelsInput): Promise<PreservePixelsResult> {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 320 || input.height < 320 || input.width > 4096 || input.height > 4096) throw new ApiError(400, 'INVALID_COMPOSITOR_LAYOUT', 'Canvas phải nằm trong khoảng 320–4096px.');
  assertBox(input.productBox, input.width, input.height, 'productBox');
  if (input.logo && !input.logoBox) throw new ApiError(400, 'INVALID_COMPOSITOR_LAYOUT', 'logoBox là bắt buộc khi có logo.');
  if (input.logoBox) assertBox(input.logoBox, input.width, input.height, 'logoBox');
  if (input.headline && !input.headlineBox) throw new ApiError(400, 'INVALID_COMPOSITOR_LAYOUT', 'headlineBox là bắt buộc khi có headline.');
  if (input.headlineBox) assertBox(input.headlineBox, input.width, input.height, 'headlineBox');
  const layers: OverlayOptions[] = [{ input: await sharp(input.productCutout).resize({ width: input.productBox.width, height: input.productBox.height, fit: 'contain', withoutEnlargement: true }).png().toBuffer(), left: input.productBox.left, top: input.productBox.top }];
  if (input.logo && input.logoBox) layers.push({ input: await sharp(input.logo).resize({ width: input.logoBox.width, height: input.logoBox.height, fit: 'contain', withoutEnlargement: true }).png().toBuffer(), left: input.logoBox.left, top: input.logoBox.top });
  if (input.headline && input.headlineBox) {
    const box = input.headlineBox;
    layers.push({ input: Buffer.from(`<svg width="${box.width}" height="${box.height}" xmlns="http://www.w3.org/2000/svg"><text x="0" y="${Math.round(box.height * .72)}" font-family="sans-serif" font-size="${Math.max(16, Math.floor(box.height * .6))}" font-weight="700" fill="#ffffff">${esc(input.headline.slice(0, 160))}</text></svg>`), left: box.left, top: box.top });
  }
  const image = await sharp(input.background).resize({ width: input.width, height: input.height, fit: 'cover', position: 'centre' }).composite(layers).webp({ quality: 82, effort: 5 }).toBuffer();
  const sha256 = createHash('sha256').update(image).digest('hex');
  return { image, sha256, manifest: { compositor_version: input.compositorVersion, template_version_id: input.templateVersionId, product_cutout_sha256: input.productCutoutSha256, logo_sha256: input.logoSha256 || null, font_sha256: input.fontSha256 || null, sharp_version: sharp.versions.sharp, runtime: `node-${process.versions.node}`, layers: { background: 'model_background_only', product: input.productBox, logo: input.logoBox || null, headline: input.headlineBox || null }, final_output_sha256: sha256 } };
}
