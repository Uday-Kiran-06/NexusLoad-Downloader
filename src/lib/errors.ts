import { NextResponse } from 'next/server';

export type ApiErrorCode =
  | 'INVALID_URL'
  | 'INVALID_FORMAT'
  | 'INVALID_REQUEST'
  | 'SERVER_BUSY'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'DOWNLOAD_TIMEOUT'
  | 'EXTRACTION_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'CONVERSION_FAILED'
  | 'CANCELLED'
  | 'DISK_SPACE'
  | 'INTERNAL_ERROR'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_READY'
  | 'JOB_EXPIRED';

export interface StructuredApiError {
  error: ApiErrorCode;
  message: string;
}

/**
 * Creates a structured, sanitized API error response.
 * Never leaks internal filesystem paths, stack traces, or stderr.
 */
export function createApiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  extraHeaders?: Record<string, string>
): NextResponse<StructuredApiError> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'X-Frame-Options': 'SAMEORIGIN',
  });

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers.set(key, value);
    }
  }

  return NextResponse.json(
    {
      error: code,
      message,
    },
    {
      status,
      headers,
    }
  );
}
