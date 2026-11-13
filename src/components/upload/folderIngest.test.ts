import test from 'node:test';
import assert from 'node:assert/strict';

import { chunkFiles, parseFolderEntries, type FolderFileInput } from './folderIngest';

function file(relativePath: string, type = 'image/jpeg', size = 1000): FolderFileInput {
  return { name: relativePath.split(/[\\/]/).pop() as string, size, type, relativePath };
}

test('nhóm ảnh theo thư mục chứa trực tiếp, tier chỉ là nhãn', () => {
  const { groups, skipped } = parseFolderEntries([
    file('dataset/tier_1_lookalike_scale/INL301/a.jpg'),
    file('dataset/tier_1_lookalike_scale/INL301/b.png', 'image/png'),
    file('dataset/tier_1_lookalike_scale/INL302/a.jpg'),
    file('dataset/tier_4_ood_negative/NEG001/a.webp', 'image/webp'),
  ]);

  assert.deepEqual(skipped, []);
  assert.deepEqual(
    groups.map((g) => [g.sku, g.tier, g.files.length]),
    [
      ['INL301', 'tier_1_lookalike_scale', 2],
      ['INL302', 'tier_1_lookalike_scale', 1],
      ['NEG001', 'tier_4_ood_negative', 1],
    ],
  );
});

test('SKU khác hoa/thường vẫn gộp một nhóm, giữ tên hiển thị gặp đầu tiên', () => {
  const { groups } = parseFolderEntries([
    file('root/INL301/a.jpg'),
    file('root/inl301/b.jpg'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sku, 'INL301');
  assert.equal(groups[0].files.length, 2);
});

test('tier null khi không có thư mục tier; chọn thẳng một thư mục SKU vẫn nhận SKU', () => {
  const { groups } = parseFolderEntries([file('INL301/a.jpg'), file('INL301/b.jpg')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sku, 'INL301');
  assert.equal(groups[0].tier, null);
});

test('tệp không phải ảnh, tệp ẩn và rác hệ thống bị loại kèm lý do', () => {
  const { groups, skipped } = parseFolderEntries([
    file('root/INL301/a.jpg'),
    file('root/INL301/notes.txt', 'text/plain'),
    file('root/INL301/.DS_Store', ''),
    file('root/INL301/Thumbs.db', ''),
    file('root/.hidden/INL302/a.jpg'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, 1);
  assert.deepEqual(
    skipped.map((s) => [s.relativePath, s.reason]).sort(),
    [
      ['root/.hidden/INL302/a.jpg', 'hidden'],
      ['root/INL301/.DS_Store', 'hidden'],
      ['root/INL301/Thumbs.db', 'not_image'],
      ['root/INL301/notes.txt', 'not_image'],
    ],
  );
});

test('nhận ảnh theo đuôi tệp khi trình duyệt không cấp MIME (HEIC)', () => {
  const { groups } = parseFolderEntries([file('root/INL301/a.HEIC', '')]);
  assert.equal(groups[0].files.length, 1);
});

test('ảnh nằm trong thư mục tier không có thư mục SKU -> no_sku_folder, không đoán', () => {
  const { groups, skipped } = parseFolderEntries([file('dataset/tier_1_lookalike_scale/a.jpg')]);
  assert.equal(groups.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), ['no_sku_folder']);
});

test('tệp không có thư mục cha -> no_sku_folder', () => {
  const { groups, skipped } = parseFolderEntries([file('a.jpg')]);
  assert.equal(groups.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), ['no_sku_folder']);
});

test('đường dẫn kiểu Windows dùng dấu gạch ngược', () => {
  const { groups } = parseFolderEntries([file('dataset\\tier_2_lookalike_lid\\LHC3219\\a.jpg')]);
  assert.equal(groups[0].sku, 'LHC3219');
  assert.equal(groups[0].tier, 'tier_2_lookalike_lid');
});

test('báo tên tệp trùng trong cùng nhóm SKU', () => {
  const { groups } = parseFolderEntries([
    file('root/INL301/a.jpg'),
    file('root/INL301/A.JPG'),
    file('root/INL301/b.jpg'),
  ]);
  assert.deepEqual(groups[0].duplicateNames, ['a.jpg']);
});

test('nhóm sắp theo SKU tự nhiên, thứ tự file giữ nguyên đầu vào', () => {
  const { groups } = parseFolderEntries([
    file('r/SKU10/a.jpg'),
    file('r/SKU2/b.jpg'),
    file('r/SKU2/a.jpg'),
  ]);
  assert.deepEqual(groups.map((g) => g.sku), ['SKU2', 'SKU10']);
  assert.deepEqual(groups[0].files.map((f) => f.name), ['b.jpg', 'a.jpg']);
});

test('đầu vào rỗng trả kết quả rỗng', () => {
  assert.deepEqual(parseFolderEntries([]), { groups: [], skipped: [] });
});

test('chunkFiles chia lô không vượt quá giới hạn và giữ thứ tự', () => {
  const items = Array.from({ length: 7 }, (_, i) => i);
  assert.deepEqual(chunkFiles(items, 3), [[0, 1, 2], [3, 4, 5], [6]]);
  assert.deepEqual(chunkFiles(items, 7), [items]);
  assert.deepEqual(chunkFiles(items, 100), [items]);
});

test('chunkFiles với đầu vào rỗng trả mảng rỗng, kích thước sai thì ném lỗi', () => {
  assert.deepEqual(chunkFiles([], 5), []);
  assert.throws(() => chunkFiles([1], 0), RangeError);
  assert.throws(() => chunkFiles([1], 1.5), RangeError);
});
