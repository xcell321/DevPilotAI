import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { ApiError } from '../errors';
import { isValidToken } from '../security/auth';
import { isLoopbackHostHeader, isLoopbackOrigin } from '../security/origin';
import type { ProcessManager, TerminalAttachment } from '../services/processManager';
import type { SessionService, SessionSummary } from '../services/sessions';

const TERMINAL_PATH = /^\/ws\/sessions\/([^/]+)\/terminals\/([^/]+)$/;
export const WS_TOKEN_PROTOCOL_PREFIX = 'devpilot.token.';
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SOCKET_BACKLOG_BYTES = 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const HEARTBEAT_MS = 30_000;
const EXPECTED_DISCONNECT_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);

interface BridgeLogger {
  error(message: string): void;
}

interface TerminalBridgeOptions {
  server: Server;
  token: string;
  manager: ProcessManager;
  sessions: SessionService;
  logger?: BridgeLogger;
}

export interface TerminalBridge {
  close(): void;
}

interface TerminalContext {
  session: SessionSummary;
  terminalId: string;
}

interface ClientSocket extends WebSocket {
  isAlive?: boolean;
}

function statusText(status: number): string {
  if (status === 400) return 'Bad Request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not Found';
  if (status === 409) return 'Conflict';
  return 'Bad Gateway';
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function sendText(socket: ClientSocket, payload: string): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
    socket.close(1013, 'Terminal client is too slow.');
    return false;
  }
  socket.send(payload);
  return true;
}

function sendJson(socket: ClientSocket, message: Record<string, unknown>): boolean {
  return sendText(socket, JSON.stringify(message));
}

function chunkText(data: string): string[] {
  if (data.length === 0) return [''];
  const chunks: string[] = [];
  for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES) {
    chunks.push(data.slice(offset, offset + OUTPUT_CHUNK_BYTES));
  }
  return chunks;
}

function sendOutput(socket: ClientSocket, data: string): boolean {
  if (!data) return true;
  for (const chunk of chunkText(data)) {
    if (!sendJson(socket, { type: 'output', data: chunk })) return false;
  }
  return true;
}

function sendReplay(socket: ClientSocket, data: string): boolean {
  const chunks = chunkText(data);
  for (let index = 0; index < chunks.length; index += 1) {
    if (
      !sendJson(socket, {
        type: 'replay',
        reset: index === 0,
        data: chunks[index],
      })
    ) {
      return false;
    }
  }
  return true;
}

function resolveContext(
  sessions: SessionService,
  sessionId: string,
  terminalId: string,
): TerminalContext | null {
  let session: SessionSummary;
  try {
    session = sessions.get(sessionId);
  } catch {
    return null;
  }
  if (!session.terminals.some((terminal) => terminal.id === terminalId)) return null;
  return { session, terminalId };
}

function isExpectedSocketDisconnect(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' && EXPECTED_DISCONNECT_CODES.has(code);
}

function requestedProtocols(request: import('node:http').IncomingMessage): string[] {
  const header = request.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return [];
  return header
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function tokenFromProtocols(
  request: import('node:http').IncomingMessage,
  token: string,
): boolean {
  const protocols = requestedProtocols(request);
  if (protocols.length !== 1) return false;
  const protocol = protocols[0]!;
  if (!protocol.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) return false;
  return isValidToken(protocol.slice(WS_TOKEN_PROTOCOL_PREFIX.length), token);
}

export function attachTerminalBridge(options: TerminalBridgeOptions): TerminalBridge {
  const { server, token, manager, sessions } = options;
  const logger = options.logger ?? console;
  const expectedProtocol = `${WS_TOKEN_PROTOCOL_PREFIX}${token}`;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols(protocols) {
      return protocols.has(expectedProtocol) ? expectedProtocol : false;
    },
  });
  const clients = new Set<ClientSocket>();
  let closed = false;

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.isAlive === false) {
        client.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const onUpgrade = (
    request: import('node:http').IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (closed || request.method !== 'GET') {
      rejectUpgrade(socket, 400, 'Invalid terminal upgrade request.');
      return;
    }
    if (!isLoopbackHostHeader(request.headers.host)) {
      rejectUpgrade(socket, 403, 'Only loopback hosts are allowed.');
      return;
    }
    if (!isLoopbackOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, 'Only loopback origins are allowed.');
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    } catch {
      rejectUpgrade(socket, 400, 'Invalid terminal URL.');
      return;
    }
    if (!tokenFromProtocols(request, token)) {
      rejectUpgrade(socket, 401, 'A valid local session token is required.');
      return;
    }

    const match = TERMINAL_PATH.exec(url.pathname);
    if (!match) {
      rejectUpgrade(socket, 404, 'Terminal not found.');
      return;
    }
    let sessionId: string;
    let terminalId: string;
    try {
      sessionId = decodeURIComponent(match[1] ?? '');
      terminalId = decodeURIComponent(match[2] ?? '');
    } catch {
      rejectUpgrade(socket, 404, 'Terminal not found.');
      return;
    }
    const context = resolveContext(sessions, sessionId, terminalId);
    if (!context) {
      rejectUpgrade(socket, 404, 'Terminal not found.');
      return;
    }
    if (!manager.hasLive(terminalId)) {
      rejectUpgrade(socket, 409, 'The terminal is not running.');
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      handleConnection(client, context);
    });
  };

  server.on('upgrade', onUpgrade);

  function handleConnection(rawClient: WebSocket, context: TerminalContext): void {
    const client = rawClient as ClientSocket;
    client.isAlive = true;
    clients.add(client);
    client.on('pong', () => {
      client.isAlive = true;
    });

    let attachment: TerminalAttachment;
    try {
      attachment = manager.attach(context.terminalId);
    } catch {
      sendJson(client, {
        type: 'error',
        code: 'terminal_not_running',
        message: 'The terminal is not running.',
      });
      client.close(1011, 'Terminal is not running.');
      clients.delete(client);
      return;
    }

    const initialSize = attachment.size();
    sendJson(client, {
      type: 'status',
      status:
        context.session.terminals.find((terminal) => terminal.id === context.terminalId)?.status ??
        'running',
      pid: manager.getLivePid(context.terminalId) ?? null,
      cols: initialSize.cols,
      rows: initialSize.rows,
    });

    const dataSubscription = attachment.onData((data) => {
      sendOutput(client, data);
    });
    const exitSubscription = attachment.onExit((event) => {
      sendJson(client, {
        type: 'exit',
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        stopRequested: event.stopRequested === true,
      });
      try {
        const terminal = sessions
          .get(context.session.id)
          .terminals.find((entry) => entry.id === context.terminalId);
        if (terminal) {
          sendJson(client, {
            type: 'status',
            status: terminal.status,
            pid: terminal.pid,
            cols: initialSize.cols,
            rows: initialSize.rows,
          });
        }
      } catch {
        // The saved session may have been removed while the process was exiting.
      }
      client.close(1000, 'Terminal exited.');
    });

    sendReplay(client, attachment.replay());

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      attachment.detach();
      dataSubscription();
      exitSubscription();
      clients.delete(client);
    };

    client.on('message', (raw, isBinary) => {
      const buffer = toBuffer(raw);
      if (buffer.length > MAX_INPUT_BYTES) {
        sendJson(client, {
          type: 'error',
          code: 'message_too_large',
          message: 'Terminal message is too large.',
        });
        return;
      }
      if (isBinary) {
        sendJson(client, {
          type: 'error',
          code: 'invalid_message',
          message: 'Binary terminal messages are not supported.',
        });
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(buffer.toString('utf8'));
      } catch {
        sendJson(client, {
          type: 'error',
          code: 'invalid_json',
          message: 'Invalid terminal message.',
        });
        return;
      }
      if (!message || typeof message !== 'object') {
        sendJson(client, {
          type: 'error',
          code: 'invalid_message',
          message: 'Invalid terminal message.',
        });
        return;
      }

      const payload = message as Record<string, unknown>;
      if (payload.type === 'input') {
        if (typeof payload.data !== 'string') {
          sendJson(client, {
            type: 'error',
            code: 'invalid_message',
            message: 'Terminal input must be text.',
          });
          return;
        }
        if (Buffer.byteLength(payload.data, 'utf8') > MAX_INPUT_BYTES) {
          sendJson(client, {
            type: 'error',
            code: 'input_too_large',
            message: 'Terminal input is too large.',
          });
          return;
        }
        try {
          attachment.write(payload.data);
        } catch (error) {
          sendJson(client, {
            type: 'error',
            code: error instanceof ApiError ? error.code : 'terminal_write_failed',
            message: error instanceof Error ? error.message : 'Terminal input failed.',
          });
        }
        return;
      }

      if (payload.type === 'resize') {
        try {
          const size = attachment.resize(Number(payload.cols), Number(payload.rows));
          sendJson(client, { type: 'resized', cols: size.cols, rows: size.rows });
        } catch (error) {
          sendJson(client, {
            type: 'error',
            code: error instanceof ApiError ? error.code : 'terminal_resize_failed',
            message: error instanceof Error ? error.message : 'Terminal resize failed.',
          });
        }
        return;
      }

      if (payload.type === 'ping') {
        sendJson(client, { type: 'pong' });
        return;
      }

      sendJson(client, {
        type: 'error',
        code: 'invalid_message',
        message: 'Unsupported terminal message type.',
      });
    });

    client.on('close', () => {
      cleanup();
      client.removeAllListeners();
    });
    client.on('error', (error) => {
      cleanup();
      if (!isExpectedSocketDisconnect(error)) {
        logger.error(
          `Terminal WebSocket failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      client.terminate();
    });
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const client of clients) {
      client.close(1001, 'Backend shutting down.');
    }
    clients.clear();
    wss.close();
  };

  server.once('close', close);
  return { close };
}
