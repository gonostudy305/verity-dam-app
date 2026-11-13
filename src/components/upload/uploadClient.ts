export interface ConvertedUploadResponse {
  storagePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** SHA-256 of the stored bytes; lets the server flag an identical re-upload. */
  sha256?: string;
  originalFileName: string;
  converted: boolean;
}

function postFileToConvert(
  file: File,
  onProgress: (progress: number) => void
): Promise<ConvertedUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/uploads/convert');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.max(1, Math.round((event.loaded / event.total) * 100)));
    };
    request.onerror = () => reject(new Error('Không thể kết nối đến máy chủ upload.'));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        try {
          const parsed = JSON.parse(request.responseText) as ConvertedUploadResponse;
          resolve(parsed);
        } catch {
          reject(new Error('Phản hồi từ máy chủ không hợp lệ.'));
        }
      } else {
        try {
          const err = JSON.parse(request.responseText);
          reject(new Error(err?.error?.message || err?.message || 'Tải lên thất bại.'));
        } catch {
          reject(new Error(`Tải lên thất bại với mã lỗi ${request.status}.`));
        }
      }
    };
    const formData = new FormData();
    formData.append('file', file);
    request.send(formData);
  });
}

export async function postFileToConvertWithRetry(
  file: File,
  onProgress: (progress: number) => void
): Promise<ConvertedUploadResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await postFileToConvert(file, onProgress);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Không thể upload tệp sau nhiều lần thử.');
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
