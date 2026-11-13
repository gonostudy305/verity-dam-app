import test from 'node:test';
import assert from 'node:assert/strict';

import { deterministicArchiveFilename } from './media-archive';

test('deterministicArchiveFilename is stable, indexed, and safe for Vietnamese titles', () => {
  assert.equal(
    deterministicArchiveFilename(0, 'Khóa cửa chính — M100', 'uploads/asset.DNG'),
    '001-khoa-cua-chinh-m100.dng'
  );
  assert.equal(
    deterministicArchiveFilename(8, 'Ảnh / cửa: góc 01', 'uploads/asset.jpeg?raw=1'),
    '009-anh-cua-goc-01.jpeg'
  );
});

test('deterministicArchiveFilename falls back to a safe name and binary extension', () => {
  assert.equal(deterministicArchiveFilename(24, '///', 'uploads/original'), '025-asset.bin');
});
