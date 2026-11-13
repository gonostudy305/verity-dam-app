export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

export async function apiRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const requestHeaders = new Headers(init?.headers);
  if (!requestHeaders.has('Accept')) {
    requestHeaders.set('Accept', 'application/json');
  }
  if (
    init?.body &&
    !(typeof FormData !== 'undefined' && init.body instanceof FormData) &&
    !requestHeaders.has('Content-Type')
  ) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(input, {
    ...init,
    headers: requestHeaders,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const apiError = payload?.error;
    const code =
      typeof apiError?.code === 'string'
        ? apiError.code
        : typeof payload?.code === 'string'
        ? payload.code
        : 'REQUEST_FAILED';
    const message =
      typeof apiError?.message === 'string'
        ? apiError.message
        : typeof apiError === 'string'
        ? apiError
        : typeof payload?.message === 'string'
        ? payload.message
        : 'Yêu cầu không thành công.';

    throw new ClientApiError(
      response.status,
      code,
      message,
      apiError?.details ?? payload?.details
    );
  }

  return payload as T;
}
