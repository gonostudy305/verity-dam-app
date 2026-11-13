export interface PickedFile {
  file: File;
  /** Đường dẫn tương đối gồm cả thư mục gốc, vd "dataset/tier_1/INL301/a.jpg". */
  relativePath: string;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    // readEntries trả từng đợt (Chrome tối đa 100 mục), phải gọi tới khi rỗng.
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
        } else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

async function walk(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    out.push({ file, relativePath: entry.fullPath.replace(/^\/+/, '') });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    for (const child of children) await walk(child, out);
  }
}

/**
 * Đọc đệ quy thư mục được thả vào trang. `dataTransfer.items` chỉ đọc được đồng
 * bộ trong sự kiện drop, nên các entry được lấy ra trước lệnh await đầu tiên.
 */
export async function collectDroppedFiles(dt: DataTransfer): Promise<PickedFile[]> {
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry?.() ?? null : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
  }
  const out: PickedFile[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}
