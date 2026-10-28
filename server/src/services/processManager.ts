import type { Db } from '../db/types';
import { ApiError } from '../errors';
import { killProcessTree, terminalEnv } from './processUtils';
import type { OwnedProcess, ProcessExit, ProcessLauncher } from './processLauncher';
import { refreshSessionStatus } from './sessionStatus';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const OUTPUT_LIMIT = 256 * 1024;
const INPUT_LIMIT = 64 * 1024;

export interface LaunchSpec {
  terminalId: string;
  sessionId: string;
  file: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface TerminalEvent {
  type: 'data' | 'exit';
  data?: string;
  exitCode?: number;
  signal?: number;
  stopRequested?: boolean;
}

export interface TerminalAttachment {
  terminalId: string;
  replay(): string;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: TerminalEvent) => void): () => void;
  write(data: string): void;
  size(): { cols: number; rows: number };
  resize(cols: number, rows: number): { cols: number; rows: number };
  detach(): void;
}

export interface ProcessManagerOptions {
  db: Db;
  launcher: ProcessLauncher;
  maxLive?: number;
  confirmMs?: number;
  startingTimeoutMs?: number;
  stopTimeoutMs?: number;
  forceWaitMs?: number;
  bufferLimit?: number;
}

interface LiveTerminal {
  terminalId: string;
  sessionId: string;
  process: OwnedProcess;
  pid: number;
  cols: number;
  rows: number;
  startedAt: string;
  confirmed: boolean;
  stopRequested: boolean;
  stopReason: string | null;
  buffer: OutputBuffer;
  subscribers: Set<(event: TerminalEvent) => void>;
  exitWaiters: Set<() => void>;
  graceTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
  disposeData: (() => void) | null;
  disposeExit: (() => void) | null;
}

interface TerminalState {
  processStatus: 'starting' | 'running' | 'exited' | 'stopped' | 'error';
  pid: number | null;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  lastError: string | null;
  errorCode: string | null;
}

class OutputBuffer {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  append(value: string): void {
    if (!value) return;
    if (value.length >= this.limit) {
      this.chunks = [value.slice(-this.limit)];
      this.length = this.limit;
      return;
    }

    this.chunks.push(value);
    this.length += value.length;

    while (this.length > this.limit) {
      const first = this.chunks[0];
      if (!first) break;
      const overflow = this.length - this.limit;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.length -= first.length;
      } else {
        this.chunks[0] = first.slice(overflow);
        this.length -= overflow;
      }
    }
  }

  read(): string {
    return this.chunks.join('');
  }
}

function spawnError(error: unknown): { code: string; message: string } {
  const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === 'ENOENT') {
    return {
      code: 'missing_executable',
      message: 'The configured executable was not found.',
    };
  }
  if (errorCode === 'EACCES' || errorCode === 'EPERM') {
    return {
      code: 'permission_denied',
      message: 'The configured executable could not be started with this Windows account.',
    };
  }
  return {
    code: 'spawn_failed',
    message: 'The CLI process could not be started.',
  };
}

function prepareFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'restart_failed',
    message: 'The terminal could not be restarted.',
  };
}

export class ProcessManager {
  private readonly db: Db;
  private readonly launcher: ProcessLauncher;
  private readonly maxLive: number;
  private readonly confirmMs: number;
  private readonly startingTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly forceWaitMs: number;
  private readonly bufferLimit: number;
  private readonly live = new Map<string, LiveTerminal>();
  private readonly locks = new Map<string, Promise<void>>();
  private launchChain: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ProcessManagerOptions) {
    this.db = options.db;
    this.launcher = options.launcher;
    this.maxLive = options.maxLive ?? 8;
    this.confirmMs = options.confirmMs ?? 1200;
    this.startingTimeoutMs = options.startingTimeoutMs ?? 10000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 1000;
    this.forceWaitMs = options.forceWaitMs ?? 1500;
    this.bufferLimit = options.bufferLimit ?? OUTPUT_LIMIT;
  }

  get liveCount(): number {
    return this.live.size;
  }

  hasLive(terminalId: string): boolean {
    return this.live.has(terminalId);
  }

  getLivePid(terminalId: string): number | undefined {
    return this.live.get(terminalId)?.pid;
  }

  start(spec: LaunchSpec, restart = false): Promise<void> {
    return this.withTerminalLock(spec.terminalId, () =>
      this.startUnlocked(spec, restart),
    );
  }

  restart(terminalId: string, prepare: () => Promise<LaunchSpec>): Promise<void> {
    return this.withTerminalLock(terminalId, async () => {
      if (this.shuttingDown) {
        throw new ApiError(503, 'shutting_down', 'The backend is shutting down.');
      }

      if (this.live.has(terminalId)) {
        await this.stopUnlocked(terminalId, 'Stopped for restart.');
      }

      let spec: LaunchSpec;
      try {
        spec = await prepare();
      } catch (error) {
        const failure = prepareFailure(error);
        this.writeState(terminalId, {
          processStatus: 'error',
          pid: null,
          exitCode: null,
          startedAt: null,
          endedAt: new Date().toISOString(),
          lastError: failure.message,
          errorCode: failure.code,
        });
        this.refresh(terminalId);
        throw error;
      }

      await this.startUnlocked({ ...spec, terminalId }, true);
    });
  }

  stop(terminalId: string, reason = 'Stopped by user.'): Promise<void> {
    return this.withTerminalLock(terminalId, () =>
      this.stopUnlocked(terminalId, reason),
    );
  }

  attach(terminalId: string): TerminalAttachment {
    const live = this.live.get(terminalId);
    if (!live) {
      throw new ApiError(409, 'terminal_not_running', 'The terminal is not running.');
    }

    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: TerminalEvent) => void>();
    let detached = false;

    const subscriber = (event: TerminalEvent): void => {
      if (detached) return;
      if (event.type === 'data' && event.data !== undefined) {
        for (const listener of dataListeners) {
          try {
            listener(event.data);
          } catch {
            // Listener failures must not affect process ownership.
          }
        }
        return;
      }
      for (const listener of exitListeners) {
        try {
          listener(event);
        } catch {
          // Listener failures must not affect process ownership.
        }
      }
    };
    live.subscribers.add(subscriber);

    return {
      terminalId,
      replay: () => live.buffer.read(),
      onData(listener) {
        dataListeners.add(listener);
        return () => {
          dataListeners.delete(listener);
        };
      },
      onExit(listener) {
        exitListeners.add(listener);
        return () => {
          exitListeners.delete(listener);
        };
      },
      write: (data) => {
        if (detached || this.live.get(terminalId) !== live) {
          throw new ApiError(409, 'terminal_not_running', 'The terminal is not running.');
        }
        if (typeof data !== 'string' || data.length === 0) return;
        if (data.length > INPUT_LIMIT) {
          throw new ApiError(400, 'terminal_input_too_large', 'Terminal input is too large.');
        }
        live.process.write(data);
      },
      size: () => ({ cols: live.cols, rows: live.rows }),
      resize: (cols, rows) => {
        if (detached || this.live.get(terminalId) !== live) {
          throw new ApiError(409, 'terminal_not_running', 'The terminal is not running.');
        }
        const boundedCols = Number.isFinite(cols)
          ? Math.min(500, Math.max(2, Math.floor(cols)))
          : DEFAULT_COLS;
        const boundedRows = Number.isFinite(rows)
          ? Math.min(200, Math.max(1, Math.floor(rows)))
          : DEFAULT_ROWS;
        live.process.resize(boundedCols, boundedRows);
        live.cols = boundedCols;
        live.rows = boundedRows;
        return { cols: boundedCols, rows: boundedRows };
      },
      detach() {
        if (detached) return;
        detached = true;
        live.subscribers.delete(subscriber);
        dataListeners.clear();
        exitListeners.clear();
      },
    };
  }

  shutdown(reason = 'Backend shutting down.'): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown(reason);
    return this.shutdownPromise;
  }

  private async performShutdown(reason: string): Promise<void> {
    await this.launchChain.catch(() => undefined);
    const ids = [...this.live.keys()];
    const results = await Promise.allSettled(
      ids.map((id) => this.stop(id, reason)),
    );

    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        `SELECT id, session_id
         FROM session_terminals
         WHERE process_status IN ('starting', 'running')`,
      )
      .all() as { id: string; session_id: string }[];
    const touched = new Set<string>();
    for (const row of rows) {
      if (this.live.has(row.id)) continue;
      this.db
        .prepare(
          `UPDATE session_terminals
           SET process_status = 'stopped', process_pid = NULL, ended_at = ?,
               last_error = ?, error_code = NULL
           WHERE id = ?`,
        )
        .run(now, reason, row.id);
      touched.add(row.session_id);
    }
    for (const sessionId of touched) {
      refreshSessionStatus(this.db, sessionId, now);
    }

    const failed = results.find((result) => result.status === 'rejected');
    if (failed && failed.status === 'rejected') {
      throw new ApiError(500, 'shutdown_failed', 'A terminal process could not be stopped.');
    }
  }

  private async startUnlocked(spec: LaunchSpec, restart: boolean): Promise<void> {
    if (this.shuttingDown) {
      throw new ApiError(503, 'shutting_down', 'The backend is shutting down.');
    }
    if (this.live.has(spec.terminalId)) {
      throw new ApiError(409, 'terminal_already_running', 'The terminal is already running.');
    }

    if (restart) {
      this.db
        .prepare('UPDATE session_terminals SET restart_count = restart_count + 1 WHERE id = ?')
        .run(spec.terminalId);
    }

    const now = new Date().toISOString();
    this.writeState(spec.terminalId, {
      processStatus: 'starting',
      pid: null,
      exitCode: null,
      startedAt: now,
      endedAt: null,
      lastError: null,
      errorCode: null,
    });
    refreshSessionStatus(this.db, spec.sessionId, now);

    await this.withLaunchSlot(async () => {
      if (this.shuttingDown) {
        this.markError(spec, 'shutting_down', 'The backend is shutting down.');
        return;
      }
      if (this.live.size >= this.maxLive) {
        this.markError(
          spec,
          'terminal_limit',
          'The maximum number of live terminals for this backend has been reached.',
        );
        return;
      }

      let child: OwnedProcess;
      try {
        child = this.launcher({
          file: spec.file,
          args: spec.args,
          cwd: spec.cwd,
          env: terminalEnv(),
          cols: spec.cols ?? DEFAULT_COLS,
          rows: spec.rows ?? DEFAULT_ROWS,
        });
      } catch (error) {
        const failure = spawnError(error);
        this.markError(spec, failure.code, failure.message);
        return;
      }

      const live: LiveTerminal = {
        terminalId: spec.terminalId,
        sessionId: spec.sessionId,
        process: child,
        pid: child.pid,
        cols: spec.cols ?? DEFAULT_COLS,
        rows: spec.rows ?? DEFAULT_ROWS,
        startedAt: now,
        confirmed: false,
        stopRequested: false,
        stopReason: null,
        buffer: new OutputBuffer(this.bufferLimit),
        subscribers: new Set(),
        exitWaiters: new Set(),
        graceTimer: null,
        startTimer: null,
        disposeData: null,
        disposeExit: null,
      };
      this.live.set(spec.terminalId, live);
      live.disposeData = child.onData((data) => this.handleData(live, data));
      live.disposeExit = child.onExit((exit) => this.handleExit(live, exit));
      live.graceTimer = setTimeout(() => this.confirmLive(live), this.confirmMs);
      live.startTimer = setTimeout(() => this.handleStartTimeout(live), this.startingTimeoutMs);
    });
  }

  private confirmLive(live: LiveTerminal): void {
    if (this.live.get(live.terminalId) !== live || live.confirmed) return;
    live.confirmed = true;
    if (live.graceTimer) {
      clearTimeout(live.graceTimer);
      live.graceTimer = null;
    }
    if (live.startTimer) {
      clearTimeout(live.startTimer);
      live.startTimer = null;
    }
    this.writeState(live.terminalId, {
      processStatus: 'running',
      pid: live.pid,
      exitCode: null,
      startedAt: live.startedAt,
      endedAt: null,
      lastError: null,
      errorCode: null,
    });
    this.refresh(live.terminalId);
  }

  private handleStartTimeout(live: LiveTerminal): void {
    if (this.live.get(live.terminalId) !== live || live.confirmed) return;
    this.removeLive(live);
    killProcessTree(live.pid);
    this.writeState(live.terminalId, {
      processStatus: 'error',
      pid: null,
      exitCode: null,
      startedAt: live.startedAt,
      endedAt: new Date().toISOString(),
      lastError: 'The CLI did not become ready in time.',
      errorCode: 'start_timeout',
    });
    this.refresh(live.terminalId);
  }

  private handleData(live: LiveTerminal, data: string): void {
    if (this.live.get(live.terminalId) !== live) return;
    live.buffer.append(data);
    for (const subscriber of live.subscribers) {
      try {
        subscriber({ type: 'data', data });
      } catch {
        // Subscriber failures must not affect process ownership.
      }
    }
  }

  private handleExit(live: LiveTerminal, exit: ProcessExit): void {
    if (this.live.get(live.terminalId) !== live) return;
    this.removeLive(live);

    const endedAt = new Date().toISOString();
    let processStatus: TerminalState['processStatus'];
    let lastError: string | null = null;
    let errorCode: string | null = null;

    if (live.stopRequested) {
      processStatus = 'stopped';
      lastError = live.stopReason ?? 'Stopped by user.';
    } else if (!live.confirmed) {
      processStatus = 'error';
      errorCode = 'immediate_exit';
      lastError = 'The CLI exited immediately after starting.';
    } else if (exit.exitCode !== 0) {
      processStatus = 'error';
      errorCode = 'unexpected_exit';
      lastError = 'The CLI exited unexpectedly.';
    } else {
      processStatus = 'exited';
    }

    this.writeState(live.terminalId, {
      processStatus,
      pid: live.pid,
      exitCode: exit.exitCode,
      startedAt: live.startedAt,
      endedAt,
      lastError,
      errorCode,
    });
    this.refresh(live.terminalId);

    for (const subscriber of live.subscribers) {
      try {
        subscriber({
          type: 'exit',
          exitCode: exit.exitCode,
          signal: exit.signal,
          stopRequested: live.stopRequested,
        });
      } catch {
        // Subscriber failures must not affect process ownership.
      }
    }
    live.subscribers.clear();

    for (const waiter of live.exitWaiters) waiter();
    live.exitWaiters.clear();
  }

  private async stopUnlocked(terminalId: string, reason: string): Promise<void> {
    const live = this.live.get(terminalId);
    if (!live) {
      throw new ApiError(409, 'terminal_not_running', 'The terminal is not running.');
    }

    live.stopRequested = true;
    live.stopReason = reason;
    try {
      live.process.write('\x03');
    } catch {
      // The process may exit while the graceful interrupt is being sent.
    }

    const exited = await this.waitForExit(live, this.stopTimeoutMs);
    if (exited || this.live.get(terminalId) !== live) return;

    killProcessTree(live.pid);
    const forced = await this.waitForExit(live, this.forceWaitMs);
    if (!forced) {
      throw new ApiError(500, 'stop_failed', 'The process tree could not be stopped.');
    }
  }

  private waitForExit(live: LiveTerminal, timeoutMs: number): Promise<boolean> {
    if (this.live.get(live.terminalId) !== live) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        live.exitWaiters.delete(waiter);
        resolve(value);
      };
      const waiter = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      live.exitWaiters.add(waiter);
    });
  }

  private removeLive(live: LiveTerminal): void {
    if (this.live.get(live.terminalId) === live) {
      this.live.delete(live.terminalId);
    }
    if (live.graceTimer) {
      clearTimeout(live.graceTimer);
      live.graceTimer = null;
    }
    if (live.startTimer) {
      clearTimeout(live.startTimer);
      live.startTimer = null;
    }
    live.disposeData?.();
    live.disposeData = null;
    live.disposeExit?.();
    live.disposeExit = null;
    for (const waiter of live.exitWaiters) waiter();
    live.exitWaiters.clear();
  }

  private markError(
    spec: LaunchSpec,
    code: string,
    message: string,
  ): void {
    this.writeState(spec.terminalId, {
      processStatus: 'error',
      pid: null,
      exitCode: null,
      startedAt: null,
      endedAt: new Date().toISOString(),
      lastError: message,
      errorCode: code,
    });
    refreshSessionStatus(this.db, spec.sessionId);
  }

  private writeState(terminalId: string, state: TerminalState): void {
    this.db
      .prepare(
        `UPDATE session_terminals
         SET process_status = ?, process_pid = ?, exit_code = ?,
             started_at = COALESCE(?, started_at), ended_at = ?,
             last_error = ?, error_code = ?
         WHERE id = ?`,
      )
      .run(
        state.processStatus,
        state.pid,
        state.exitCode,
        state.startedAt,
        state.endedAt,
        state.lastError,
        state.errorCode,
        terminalId,
      );
  }

  private refresh(terminalId: string): void {
    const row = this.db
      .prepare('SELECT session_id FROM session_terminals WHERE id = ?')
      .get(terminalId) as { session_id: string } | undefined;
    if (row) refreshSessionStatus(this.db, row.session_id);
  }

  private withLaunchSlot<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.launchChain.catch(() => undefined).then(operation);
    this.launchChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private withTerminalLock<T>(terminalId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(terminalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    this.locks.set(
      terminalId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
