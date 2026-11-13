import { NextResponse } from 'next/server';

import { ValidationError } from '@/lib/media-api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
        ...(Array.isArray(error.details) ? { data: { protected: error.details } } : {}),
      },
      { status: error.status }
    );
  }

  if (error instanceof ValidationError) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_ERROR', message: error.message } },
      { status: 400 }
    );
  }

  console.error('Unhandled API error', error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Không thể xử lý yêu cầu. Vui lòng thử lại.' } },
    { status: 500 }
  );
}

export function notFound(message = 'Không tìm thấy tài nguyên.') {
  return new ApiError(404, 'NOT_FOUND', message);
}
