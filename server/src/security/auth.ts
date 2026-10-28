import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export function createToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidToken(provided: string | null | undefined, token: string): boolean {
  return provided !== null && provided !== undefined && safeEqual(provided, token);
}

export function requireToken(token: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.get('x-devpilot-token');
    if (!isValidToken(provided, token)) {
      res.status(401).json({
        error: {
          code: 'unauthorized',
          message: 'A valid local session token is required.',
        },
      });
      return;
    }
    next();
  };
}
