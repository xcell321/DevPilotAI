import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type ClientOptions } from 'ws';
import protocol from '../../shared/protocol.cjs';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db/types';
import type { OwnedProcess, ProcessExit, ProcessLauncher } from '../src/services/processLauncher';
import { ProcessManager } from '../src/services/processManager';
import { SessionService, type SessionSummary } from '../src/services/sessions';
import { seedToolProfiles } from '../src/services/toolRegistry';
import { attachTerminalBridge, type TerminalBridge } from '../src/ws/terminalBridge';

const { TOKEN_HEADER, WS_TOKEN_PROTOCOL_PREFIX } = protocol;
const TOKEN = 'test-token-0123456789abcdef';
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const MAX_WS_MESSAGE_BYTES = 128 * 1024;

let tempDir: string;
let db: Db;
let config: AppConfig;
let app: ReturnType<typeof createApp>;
let manager: ProcessManager;
let sessions: SessionService;
let server: Server;
let bridge: TerminalBridge | null;
let scriptPath: string;
let port: number;
let resizeEvents: Array<{ pid: number; cols: number; rows: number }>;
let socketErrors: string[];
const trackedPids = new Set<number>();
const clients = new Set<WebSocket>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 8000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await wait(40);
  }
  throw new Error(message);
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

function createChildProcessLauncher(): ProcessLauncher {
  return (spec) => {
    const child: ChildProcessWithoutNullStreams = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (!child.pid) throw new Error('Test process did not receive a pid.');
    const pid = child.pid;
    trackedPids.add(pid);

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(exit: ProcessExit) => void>();
    const pendingData: string[] = [];
    let exitInfo: ProcessExit | null = null;

    const emitData = (data: Buffer | string) => {
      const text = data.toString();
      if (dataListeners.size === 0) {
        pendingData.push(text);
        return;
      }
      for (const listener of dataListeners) listener(text);
    };
    const emitExit = (exit: ProcessExit) => {
      if (exitInfo) return;
      exitInfo = exit;
      for (const listener of exitListeners) listener(exit);
      exitListeners.clear();
    };

    child.stdout.on('data', emitData);
    child.stderr.on('data', emitData);
    child.stdin.on('error', () => undefined);
    child.on('error', () => emitExit({ exitCode: 1 }));
    child.on('exit', (code) => emitExit({ exitCode: code ?? 1 }));

    const owned: OwnedProcess = {
      pid,
      onData(listener) {
        dataListeners.add(listener);
        while (pendingData.length > 0) listener(pendingData.shift()!);
        return () => {
          dataListeners.delete(listener);
        };
      },
      onExit(listener) {
        if (exitInfo) {
          queueMicrotask(() => listener(exitInfo!));
          return () => undefined;
        }
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      write(data) {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      resize(cols, rows) {
        resizeEvents.push({ pid, cols, rows });
      },
      kill() {
        child.kill();
      },
    };
    return owned;
  };
}

type WsMessage = Record<string, unknown>;

class MessageQueue {
  private readonly queue: WsMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: WsMessage) => boolean;
    resolve: (message: WsMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on('message', (raw) => {
      let message: WsMessage;
      try {
        message = JSON.parse(raw.toString()) as WsMessage;
      } catch {
        return;
      }
      this.queue.push(message);
      this.flush();
    });
  }

  next(
    predicate: (message: WsMessage) => boolean = () => true,
    timeoutMs = 6000,
  ): Promise<WsMessage> {
    const index = this.queue.findIndex(predicate);
    if (index >= 0) {
      return Promise.resolve(this.queue.splice(index, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.waiters.indexOf(waiter);
          if (current >= 0) this.waiters.splice(current, 1);
          reject(
            new Error(
              `Timed out waiting for a terminal message. Queued types: ${this.queue
                .map((message) => String(message.type))
                .join(', ')}`,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private flush(): void {
    for (const waiter of [...this.waiters]) {
      const index = this.queue.findIndex(waiter.predicate);
      if (index < 0) continue;
      const message = this.queue.splice(index, 1)[0]!;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  }
}

function wsUrl(sessionId: string, terminalId: string, query = ''): string {
  return (
    `ws://127.0.0.1:${port}/ws/sessions/${encodeURIComponent(sessionId)}` +
    `/terminals/${encodeURIComponent(terminalId)}${query ? `?${query}` : ''}`
  );
}

function tokenProtocol(token = TOKEN): string {
  return `${WS_TOKEN_PROTOCOL_PREFIX}${token}`;
}

function openSocket(
  sessionId: string,
  terminalId: string,
  token: string | null,
  options: ClientOptions = {},
  query = '',
): WebSocket {
  const url = wsUrl(sessionId, terminalId, query);
  return token === null
    ? new WebSocket(url, options)
    : new WebSocket(url, tokenProtocol(token), options);
}

function connect(
  sessionId: string,
  terminalId: string,
  options: ClientOptions = {},
): Promise<{ socket: WebSocket; queue: MessageQueue }> {
  return new Promise((resolve, reject) => {
    const socket = openSocket(sessionId, terminalId, TOKEN, options);
    clients.add(socket);
    const queue = new MessageQueue(socket);
    let opened = false;
    socket.on('open', () => {
      opened = true;
      if (socket.protocol !== tokenProtocol()) {
        reject(new Error('The server did not negotiate the token subprotocol.'));
        socket.terminate();
        return;
      }
      resolve({ socket, queue });
    });
    socket.on('error', (error) => {
      if (!opened) reject(error);
    });
  });
}

function expectUpgradeStatus(
  sessionId: string,
  terminalId: string,
  token: string | null,
  status: number,
  options: ClientOptions = {},
  query = '',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = openSocket(sessionId, terminalId, token, options, query);
    clients.add(socket);
    let settled = false;
    socket.on('unexpected-response', (_request, response) => {
      if (settled) return;
      settled = true;
      try {
        expect(response.statusCode).toBe(status);
        response.resume();
        socket.terminate();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on('open', () => {
      if (settled) return;
      settled = true;
      socket.terminate();
      reject(new Error('Expected the WebSocket upgrade to be rejected.'));
    });
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new Error(`WebSocket closed before receiving HTTP ${status}.`));
    });
  });
}

function waitForClose(
  socket: WebSocket,
  timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: 1005, reason: '' });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close.')), timeoutMs);
    socket.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function collectReplay(
  queue: MessageQueue,
  first: WsMessage,
  quietMs = 350,
): Promise<{ chunks: WsMessage[]; text: string }> {
  const chunks = [first];
  let text = typeof first.data === 'string' ? first.data : '';
  for (;;) {
    try {
      const next = await queue.next((message) => message.type === 'replay', quietMs);
      chunks.push(next);
      if (typeof next.data === 'string') text += next.data;
    } catch {
      return { chunks, text };
    }
  }
}

async function send(socket: WebSocket, payload: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(payload), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-ws-'));
  config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
    DEVPILOT_RUNTIME_DIR: path.join(tempDir, 'runtime'),
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  db.prepare('UPDATE tool_profiles SET default_on_quick_start = 0').run();

  scriptPath = path.join(tempDir, 'ws-fixture.cjs');
  fs.writeFileSync(
    scriptPath,
    `const fs = require('node:fs');
const keepAlive = () => setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
const mode = process.argv[2];
if (mode === 'ws-echo') {
  process.stdout.write('ready\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    process.stdout.write('echo:' + chunk);
    if (chunk.includes('exit')) setTimeout(() => process.exit(3), 30);
  });
  keepAlive();
} else if (mode === 'ws-large') {
  process.stdout.write('A'.repeat(150000) + 'END');
  keepAlive();
} else if (mode === 'ws-hold') {
  process.stdout.write('hold-ready\\n');
  keepAlive();
} else {
  fs.writeFileSync(process.argv[3] || '', 'unexpected');
  keepAlive();
}
`,
  );

  resizeEvents = [];
  socketErrors = [];
  manager = new ProcessManager({
    db,
    launcher: createChildProcessLauncher(),
    maxLive: 8,
    confirmMs: 100,
    startingTimeoutMs: 4000,
    stopTimeoutMs: 250,
    forceWaitMs: 2000,
    bufferLimit: 200 * 1024,
  });
  sessions = new SessionService(
    db,
    manager,
    config.maxTerminalsPerSession,
    config.runtimeDir,
  );
  app = createApp({
    config,
    db,
    token: TOKEN,
    terminalSupport: { status: 'available', detail: 'test-only child-process registry' },
    processManager: manager,
    sessionService: sessions,
  });

  server = http.createServer(app);
  bridge = null;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  bridge = attachTerminalBridge({
    server,
    token: TOKEN,
    manager,
    sessions,
    logger: { error: (message) => socketErrors.push(message) },
  });
});

afterEach(async () => {
  for (const client of clients) {
    try {
      client.terminate();
    } catch {
      // Already closed.
    }
  }
  clients.clear();
  try {
    bridge?.close();
  } catch {
    // Best-effort bridge cleanup.
  }
  try {
    await manager.shutdown();
  } catch {
    // Best-effort process cleanup.
  }
  for (const pid of trackedPids) killTree(pid);
  trackedPids.clear();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function authorized(
  method: 'get' | 'post',
  url: string,
) {
  return request(app)[method](url).set(TOKEN_HEADER, TOKEN);
}

async function makeProject(
  name: string,
  initializeGit = false,
): Promise<{ id: string; path: string }> {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { recursive: true });
  if (initializeGit) {
    const initialized = spawnSync('git', ['-C', directory, 'init', '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (initialized.status !== 0) {
      throw new Error(`Could not initialize test Git repository: ${initialized.stderr}`);
    }
    const committed = spawnSync(
      'git',
      [
        '-C',
        directory,
        '-c',
        'user.name=DevPilot Test',
        '-c',
        'user.email=devpilot-test@example.invalid',
        'commit',
        '--allow-empty',
        '--quiet',
        '-m',
        'Initial',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (committed.status !== 0) {
      throw new Error(`Could not commit test Git repository: ${committed.stderr}`);
    }
  }
  const canonical = fs.realpathSync.native(directory);
  const response = await authorized('post', '/api/projects').send({ path: canonical, name });
  expect(response.status).toBe(201);
  return { id: response.body.project.id as string, path: canonical };
}

function addProfile(id: string, mode: string): void {
  db.prepare(
    `INSERT INTO tool_profiles (
       id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
       launch_verified, last_status, last_checked_at, notes
     ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
  ).run(
    id,
    id,
    process.execPath,
    JSON.stringify([scriptPath, mode]),
    new Date().toISOString(),
    'Test-only WebSocket child process profile.',
  );
}

async function createSession(
  projectId: string,
  toolIds: string[],
): Promise<SessionSummary> {
  const response = await authorized('post', '/api/sessions').send({
    projectId,
    mode: 'custom',
    toolIds,
  });
  expect(response.status).toBe(201);
  const session = response.body.session as SessionSummary;
  await waitUntil(
    () => session.terminals.every((terminal) => manager.hasLive(terminal.id)),
    'Session terminals did not become live.',
  );
  await wait(250);
  return session;
}

describe('terminal WebSocket bridge', () => {
  it('rejects invalid tokens, origins, hosts, ownership, and non-live terminals', async () => {
    addProfile('ws-echo', 'ws-echo');
    addProfile('ws-hold', 'ws-hold');
    const project = await makeProject('ws-security');
    const session = await createSession(project.id, ['ws-echo']);
    const terminalId = session.terminals[0]!.id;
    const other = await createSession(project.id, ['ws-hold']);

    await expectUpgradeStatus(session.id, terminalId, 'wrong-token', 401);
    await expectUpgradeStatus(session.id, terminalId, null, 401);
    await expectUpgradeStatus(
      session.id,
      terminalId,
      null,
      401,
      {},
      `token=${TOKEN}`,
    );
    await expectUpgradeStatus(session.id, terminalId, TOKEN, 403, {
      headers: { Origin: 'https://evil.example' },
    });
    await expectUpgradeStatus(session.id, terminalId, TOKEN, 403, {
      headers: { Host: 'evil.example' },
    });
    await expectUpgradeStatus(other.id, terminalId, TOKEN, 404);
    await expectUpgradeStatus(session.id, 'missing-terminal', TOKEN, 404);

    const stop = await authorized('post', `/api/terminals/${terminalId}/stop`);
    expect(stop.status).toBe(200);
    await expectUpgradeStatus(session.id, terminalId, TOKEN, 409);
  });

  it('streams replay, input, resize, exit, and one process across reconnects', async () => {
    addProfile('ws-echo', 'ws-echo');
    const project = await makeProject('ws-stream');
    const session = await createSession(project.id, ['ws-echo']);
    const terminalId = session.terminals[0]!.id;

    const first = await connect(session.id, terminalId);
    const status = await first.queue.next((message) => message.type === 'status');
    expect(status.pid).toBeTypeOf('number');
    const replay = await first.queue.next((message) => message.type === 'replay');
    const replayed = await collectReplay(first.queue, replay);
    expect(replayed.text).toContain('ready');
    expect(replayed.chunks[0]?.reset).toBe(true);

    await send(first.socket, { type: 'input', data: 'hello\n' });
    const echo = await first.queue.next(
      (message) => message.type === 'output' && String(message.data).includes('echo:hello'),
    );
    expect(echo.data).toContain('echo:hello');

    await send(first.socket, { type: 'resize', cols: 140, rows: 42 });
    const resized = await first.queue.next((message) => message.type === 'resized');
    expect(resized).toMatchObject({ cols: 140, rows: 42 });
    await waitUntil(
      () => resizeEvents.some((event) => event.cols === 140 && event.rows === 42),
      'Resize did not reach the owned process.',
    );

    const pidBefore = manager.getLivePid(terminalId);
    expect(pidBefore).toBeTypeOf('number');
    const firstClosed = waitForClose(first.socket);
    first.socket.close();
    await firstClosed;

    const second = await connect(session.id, terminalId);
    const secondReplay = await second.queue.next((message) => message.type === 'replay');
    const secondReplayed = await collectReplay(second.queue, secondReplay);
    expect(secondReplayed.text).toContain('ready');
    expect(secondReplayed.text).toContain('echo:hello');
    expect(manager.getLivePid(terminalId)).toBe(pidBefore);

    const exitMessage = second.queue.next((message) => message.type === 'exit');
    const closed = waitForClose(second.socket);
    await send(second.socket, { type: 'input', data: 'exit\n' });
    await expect(exitMessage).resolves.toMatchObject({ exitCode: 3, stopRequested: false });
    await closed;
    expect(manager.hasLive(terminalId)).toBe(false);
  });

  it('detaches abrupt client disconnects without stopping the owned process', async () => {
    addProfile('ws-hold', 'ws-hold');
    const project = await makeProject('ws-abrupt');
    const session = await createSession(project.id, ['ws-hold']);
    const terminalId = session.terminals[0]!.id;
    const client = await connect(session.id, terminalId);
    await client.queue.next((message) => message.type === 'status');
    const pid = manager.getLivePid(terminalId);

    client.socket.terminate();
    await wait(250);

    expect(manager.getLivePid(terminalId)).toBe(pid);
    expect(socketErrors).toEqual([]);

    const reconnected = await connect(session.id, terminalId);
    const status = await reconnected.queue.next((message) => message.type === 'status');
    expect(status.pid).toBe(pid);
  });

  it('logs unexpected socket failures while keeping the owned process alive', async () => {
    addProfile('ws-hold', 'ws-hold');
    const project = await makeProject('ws-failure');
    const session = await createSession(project.id, ['ws-hold']);
    const terminalId = session.terminals[0]!.id;
    const client = await connect(session.id, terminalId);
    await client.queue.next((message) => message.type === 'status');
    const pid = manager.getLivePid(terminalId);
    const closed = waitForClose(client.socket);

    client.socket.send(Buffer.alloc(MAX_WS_MESSAGE_BYTES + 1));
    await closed;

    expect(socketErrors.some((message) => message.includes('Terminal WebSocket failed'))).toBe(
      true,
    );
    expect(manager.getLivePid(terminalId)).toBe(pid);
  });

  it('keeps terminal output isolated and replays large buffered output in bounded chunks', async () => {
    addProfile('ws-echo', 'ws-echo');
    addProfile('ws-large', 'ws-large');
    const project = await makeProject('ws-isolation', true);
    const session = await createSession(project.id, ['ws-echo', 'ws-large']);
    const echoTerminal = session.terminals.find(
      (terminal) => terminal.toolProfileId === 'ws-echo',
    )!;
    const largeTerminal = session.terminals.find(
      (terminal) => terminal.toolProfileId === 'ws-large',
    )!;

    await wait(600);
    const echoClient = await connect(session.id, echoTerminal.id);
    const largeClient = await connect(session.id, largeTerminal.id);

    const largeFirst = await largeClient.queue.next((message) => message.type === 'replay');
    const large = await collectReplay(largeClient.queue, largeFirst, 600);
    expect(large.chunks.length).toBeGreaterThan(1);
    expect(large.chunks[0]?.reset).toBe(true);
    for (const chunk of large.chunks) {
      expect(chunk.reset).toBe(chunk === large.chunks[0]);
      expect(String(chunk.data).length).toBeLessThanOrEqual(OUTPUT_CHUNK_BYTES);
    }
    expect(large.text.length).toBe(150003);
    expect(large.text.endsWith('END')).toBe(true);

    await send(echoClient.socket, { type: 'input', data: 'isolated\n' });
    await echoClient.queue.next(
      (message) => message.type === 'output' && String(message.data).includes('echo:isolated'),
    );

    await expect(
      largeClient.queue.next(
        (message) =>
          message.type === 'output' && String(message.data).includes('echo:isolated'),
        500,
      ),
    ).rejects.toThrow(/Timed out/);
  }, 30000);

  it('closes attached clients cleanly when the bridge shuts down', async () => {
    addProfile('ws-hold', 'ws-hold');
    const project = await makeProject('ws-shutdown');
    const session = await createSession(project.id, ['ws-hold']);
    const client = await connect(session.id, session.terminals[0]!.id);
    const closed = waitForClose(client.socket);

    bridge?.close();
    bridge = null;

    const event = await closed;
    expect(event.code).toBe(1001);
    expect(manager.hasLive(session.terminals[0]!.id)).toBe(true);
  });
});
