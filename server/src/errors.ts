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

export function sendApiError(res: Response, error: unknown): void {
  if (error instanceof ApiError) {
    res.status(error.status).json({
      error: { code: error.code, message: error.message },
    });
    return;
  }

  console.error(`Request failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Unexpected request failure.' },
  });
}
