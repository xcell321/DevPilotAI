import type { z } from 'zod';
import { ApiError } from '../errors';

interface ParseBodyOptions {
  code?: string;
  message?: string;
}

export function parseBody<T>(
  schema: z.ZodType<T>,
  body: unknown,
  options: ParseBodyOptions = {},
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      options.code ?? 'invalid_request',
      parsed.error.issues[0]?.message ?? options.message ?? 'Invalid request.',
    );
  }
  return parsed.data;
}
