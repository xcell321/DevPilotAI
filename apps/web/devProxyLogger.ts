import { createLogger, type LogErrorOptions, type Logger } from 'vite';

const EXPECTED_DISCONNECT_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);
const WS_PROXY_PREFIXES = ['ws proxy error:', 'ws proxy socket error:'];

function isExpectedProxyDisconnect(message: string, options?: LogErrorOptions): boolean {
  if (!WS_PROXY_PREFIXES.some((prefix) => message.includes(prefix))) return false;
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && EXPECTED_DISCONNECT_CODES.has(code);
}

export function createDevLogger(): Logger {
  const logger = createLogger();
  return {
    ...logger,
    error(message, options) {
      if (isExpectedProxyDisconnect(message, options)) return;
      logger.error(message, options);
    },
  };
}
