import type { RequestHandler } from 'express';
import { isLoopbackHost } from '../config';

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

export function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export const apiOriginGuard: RequestHandler = (req, res, next) => {
  if (!isLoopbackHostHeader(req.headers.host)) {
    res.status(403).json({
      error: { code: 'forbidden_host', message: 'Only loopback hosts are allowed.' },
    });
    return;
  }

  if (!isLoopbackOrigin(req.headers.origin)) {
    res.status(403).json({
      error: { code: 'forbidden_origin', message: 'Only loopback origins are allowed.' },
    });
    return;
  }

  next();
};
