import type { Response } from 'express';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function errorText(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error ? error.message : fallback;
}

export function sendApiError(res: Response, error: unknown): void {
  if (error instanceof ApiError) {
    // Sanitize: never leak raw user input or request body in error messages
    const safeMessage =
      error.message && error.message.includes('The request body is')
        ? 'The request body is invalid.'
        : error.message;
    res.status(error.status).json({
      error: { code: error.code, message: safeMessage },
    });
    return;
  }

  console.error(`Request failed: ${errorText(error)}`);
  // Don't leak request body or sensitive data in generic error
  res.status(500).json({
    error: { code: 'internal_error', message: 'Unexpected request failure.' },
  });
}
