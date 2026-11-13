/**
 * Phân tích cây thư mục người dùng chọn thành các nhóm theo SKU.
 *
 * Quy tắc (Zero Speculation): SKU là tên thư mục *trực tiếp chứa ảnh*. Thư mục
 * kiểu "tier_1_..." chỉ là nhãn tier, không bao giờ được coi là SKU. Không đoán
 * SKU từ tên tệp hay nội dung ảnh; việc SKU có tồn tại hay không do bước xem
 * trước kiểm tra với danh mục sản phẩm.
 */

export interface FolderFileInput {
  name: string;
  size: number;
  type: string;
  /** Đường dẫn tương đối gồm cả thư mục gốc, vd File.webkitRelativePath. */
  relativePath: string;
}

export type SkippedReason = 'hidden' | 'not_image' | 'no_sku_folder';

export interface SkippedFile {
  relativePath: string;
  reason: SkippedReason;
}

export interface FolderSkuGroup<T extends FolderFileInput = FolderFileInput> {
  /** Tên thư mục SKU như người dùng đặt (lần gặp đầu tiên). */
  sku: string;
  tier: string | null;
  files: T[];
  /** Tên tệp (chữ thường) xuất hiện nhiều hơn một lần trong nhóm. */
  duplicateNames: string[];
}

export interface FolderParseResult<T extends FolderFileInput = FolderFileInput> {
  groups: FolderSkuGroup<T>[];
  skipped: SkippedFile[];
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'heic', 'heif']);
const IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'image/heif',
]);
const TIER_FOLDER = /^tier[\s_-]*\d+/i;

function isImage(name: string, type: string) {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return IMAGE_EXTENSIONS.has(ext) || IMAGE_MIME_TYPES.has(type.toLowerCase());
}

export function parseFolderEntries<T extends FolderFileInput>(files: T[]): FolderParseResult<T> {
  const skipped: SkippedFile[] = [];
  const byKey = new Map<string, FolderSkuGroup<T>>();

  for (const file of files) {
    const segments = file.relativePath.split(/[\\/]+/).filter(Boolean);
    const dirs = segments.slice(0, -1);
    const fileName = segments[segments.length - 1] ?? file.name;

    if (segments.some((segment) => segment.startsWith('.'))) {
      skipped.push({ relativePath: file.relativePath, reason: 'hidden' });
      continue;
    }
    if (!isImage(fileName, file.type || '')) {
      skipped.push({ relativePath: file.relativePath, reason: 'not_image' });
      continue;
    }

    const parent = dirs[dirs.length - 1]?.trim();
    if (!parent || TIER_FOLDER.test(parent)) {
      skipped.push({ relativePath: file.relativePath, reason: 'no_sku_folder' });
      continue;
    }

    const key = parent.toLowerCase();
    let group = byKey.get(key);
    if (!group) {
      group = {
        sku: parent,
        tier: dirs.find((dir) => TIER_FOLDER.test(dir)) ?? null,
        files: [],
        duplicateNames: [],
      };
      byKey.set(key, group);
    }
    group.files.push(file);
  }

  const groups = [...byKey.values()].sort((a, b) =>
    a.sku.localeCompare(b.sku, undefined, { numeric: true, sensitivity: 'base' }),
  );

  for (const group of groups) {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const file of group.files) {
      const name = (file.relativePath.split(/[\\/]+/).pop() ?? file.name).toLowerCase();
      if (seen.has(name)) repeated.add(name);
      seen.add(name);
    }
    group.duplicateNames = [...repeated];
  }

  return { groups, skipped };
}

/** Chia danh sách thành các lô tối đa `size` phần tử, giữ nguyên thứ tự. */
export function chunkFiles<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('Kích thước lô phải là số nguyên >= 1.');
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
