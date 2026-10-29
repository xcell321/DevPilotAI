import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import protocol from '../../shared/protocol.cjs';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase } from '../src/db';
import { migration001 } from '../src/db/migrations/001-initial';
import { migration002 } from '../src/db/migrations/002-project-path-key';
import type { Db } from '../src/db/types';
import type { ProcessLauncher, OwnedProcess, ProcessExit } from '../src/services/processLauncher';
import { ProcessManager } from '../src/services/processManager';
import { deriveSessionStatus } from '../src/services/sessionStatus';
import { reconcileStaleTerminals } from '../src/services/startup';
import { seedToolProfiles } from '../src/services/toolRegistry';

const { TOKEN_HEADER } = protocol;
const TOKEN = 'test-token-0123456789abcdef';

let tempDir: string;
let db: Db;
let config: AppConfig;
let app: ReturnType<typeof createApp>;
let manager: ProcessManager;
let launcher: ProcessLauncher;
let scriptPath: string;
let managers: ProcessManager[];
const trackedPids = new Set<number>();

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
    await wait(50);
  }
  throw new Error(message);
}

function isAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    trackedPids.add(child.pid);

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
      pid: child.pid,
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
      resize() {
        return undefined;
      },
      kill() {
        child.kill();
      },
    };
    return owned;
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-sessions-'));
  config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_RUNTIME_DIR: path.join(tempDir, 'runtime'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
    DEVPILOT_MAX_TERMINALS: '8',
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  db.prepare('UPDATE tool_profiles SET default_on_quick_start = 0').run();

  scriptPath = path.join(tempDir, 'runtime-fixture.cjs');
  fs.writeFileSync(
    scriptPath,
    `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
const target = process.argv[3];
const keepAlive = () => setInterval(() => {}, 1000);
process.on('SIGTERM', () => {});
if (mode === 'immediate') {
  setTimeout(() => process.exit(7), 30);
} else if (mode === 'tree') {
  process.on('SIGINT', () => {});
  const child = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
  fs.writeFileSync(target, String(child.pid));
  keepAlive();
} else if (mode === 'output') {
  process.stdout.write('A'.repeat(10000) + 'END');
  keepAlive();
} else if (mode === 'env') {
  fs.writeFileSync(target, JSON.stringify({
    cwd: process.cwd(),
    pid: process.pid,
    token: process.env.DEVPILOT_TOKEN ?? null,
    secret: process.env.DEVPILOT_TEST_SECRET ?? null,
    anthropicToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    hasPath: Boolean(process.env.PATH),
    term: process.env.TERM ?? null
  }));
  keepAlive();
} else {
  fs.writeFileSync(target, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
  keepAlive();
}
`,
  );

  launcher = createChildProcessLauncher();
  manager = new ProcessManager({
    db,
    launcher,
    maxLive: 8,
    confirmMs: 150,
    startingTimeoutMs: 4000,
    stopTimeoutMs: 250,
    forceWaitMs: 2000,
    bufferLimit: 4096,
  });
  managers = [manager];
  app = createApp({
    config,
    db,
    token: TOKEN,
    terminalSupport: { status: 'available', detail: 'test-only child-process registry' },
    processManager: manager,
  });
});

afterEach(async () => {
  for (const item of managers) {
    try {
      await item.shutdown();
    } catch {
      // Best-effort cleanup so one failed assertion cannot leave children behind.
    }
  }
  for (const pid of trackedPids) killTree(pid);
  trackedPids.clear();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function authorized(
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  target = app,
) {
  return request(target)[method](url).set(TOKEN_HEADER, TOKEN);
}

async function makeProject(name = 'Runtime Project', initializeGit = false) {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { recursive: true });
  if (initializeGit) {
    const git = spawnSync('git', ['-C', directory, 'init', '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (git.status !== 0) {
      throw new Error(`Could not initialize test Git repository: ${git.stderr}`);
    }
    for (const [key, value] of [
      ['user.name', 'DevPilot Test'],
      ['user.email', 'devpilot-test@example.invalid'],
    ]) {
      const configResult = spawnSync('git', ['-C', directory, 'config', key, value], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (configResult.status !== 0) {
        throw new Error(`Could not configure test Git repository: ${configResult.stderr}`);
      }
    }
    const commit = spawnSync(
      'git',
      ['-C', directory, 'commit', '--allow-empty', '--quiet', '-m', 'Initial'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (commit.status !== 0) {
      throw new Error(`Could not commit test Git repository: ${commit.stderr}`);
    }
  }
  const canonical = fs.realpathSync.native(directory);
  const response = await authorized('post', '/api/projects').send({ path: canonical, name });
  expect(response.status).toBe(201);
  return { id: response.body.project.id as string, path: canonical, name };
}

interface ProfileOptions {
  enabled?: boolean;
  verified?: boolean;
  defaultQuick?: boolean;
  command?: string;
  status?: 'available' | 'missing' | 'unknown' | 'unverified';
  args?: string[];
}

function addProfile(id: string, mode: string, options: ProfileOptions = {}) {
  const evidence = path.join(tempDir, `${id}.json`);
  const args = options.args ?? [scriptPath, mode, evidence];
  db.prepare(
    `INSERT INTO tool_profiles (
       id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
       launch_verified, last_status, last_checked_at, notes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    options.command ?? process.execPath,
    JSON.stringify(args),
    options.enabled === false ? 0 : 1,
    options.defaultQuick ? 1 : 0,
    options.verified === false ? 0 : 1,
    options.status ?? 'available',
    new Date().toISOString(),
    'Test-only child process profile.',
  );
  return evidence;
}

function evidenceFor(id: string): string {
  return path.join(tempDir, `${id}.json`);
}

async function getSession(id: string, target = app) {
  const response = await authorized('get', `/api/sessions/${id}`, target);
  expect(response.status).toBe(200);
  return response.body.session;
}

describe('session status mapping', () => {
  it('derives honest aggregate and stale states', () => {
    expect(deriveSessionStatus([])).toBe('created');
    expect(
      deriveSessionStatus([{ process_status: 'running', error_code: null }]),
    ).toBe('running');
    expect(
      deriveSessionStatus([
        { process_status: 'running', error_code: null },
        { process_status: 'error', error_code: 'immediate_exit' },
      ]),
    ).toBe('running');
    expect(
      deriveSessionStatus([{ process_status: 'stopped', error_code: 'backend_restarted' }]),
    ).toBe('unavailable');
    expect(
      deriveSessionStatus([{ process_status: 'error', error_code: 'spawn_failed' }]),
    ).toBe('error');
  });
});

describe('session creation contract', () => {
  it('rejects extra launch fields, invalid modes, and malformed tool selections', async () => {
    const project = await makeProject();
    const cases: Array<Record<string, unknown>> = [
      { projectId: project.id, mode: 'custom', toolIds: ['test-stay'], command: 'calc.exe' },
      { projectId: project.id, mode: 'quick', toolIds: ['test-stay'] },
      { projectId: project.id, mode: 'custom' },
      { projectId: project.id, mode: 'custom', toolIds: ['a', 'a'] },
      { projectId: project.id, mode: 'custom', toolIds: ['a', 'b', 'c', 'd', 'e'] },
      { projectId: project.id, mode: 'other', toolIds: ['test-stay'] },
    ];

    for (const body of cases) {
      const response = await authorized('post', '/api/sessions').send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('invalid_request');
    }
  });

  it('uses the configured per-session terminal limit as the server authority', async () => {
    const project = await makeProject('Runtime Project', true);
    addProfile('limit-a', 'stay');
    addProfile('limit-b', 'stay');
    addProfile('limit-c', 'stay');
    const limitedConfig = loadConfig({
      DEVPILOT_DB_PATH: config.dbPath,
      DEVPILOT_RUNTIME_DIR: config.runtimeDir,
      DEVPILOT_WEB_DIST: config.webDist,
      DEVPILOT_MAX_TERMINALS_PER_SESSION: '2',
    });

    const limitedApp = createApp({
      config: limitedConfig,
      db,
      token: TOKEN,
      terminalSupport: { status: 'available', detail: 'test-only session limit' },
      processManager: manager,
    });

    const overview = await authorized('get', '/api/overview', limitedApp);
    expect(overview.body.limits).toEqual({ maxTerminalsPerSession: 2 });

    const rejected = await authorized('post', '/api/sessions', limitedApp).send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['limit-a', 'limit-b', 'limit-c'],
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.message).toContain('Too many CLI profiles');

    const accepted = await authorized('post', '/api/sessions', limitedApp).send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['limit-a', 'limit-b'],
    });
    expect(accepted.status).toBe(201);
    await authorized('post', `/api/sessions/${accepted.body.session.id}/stop`, limitedApp);
  }, 20000);

  it('rejects overlapping or unsafe declared scopes before creating sessions or processes', async () => {
    const project = await makeProject('Task Scope Validation');
    addProfile('scope-validation-a', 'stay');
    addProfile('scope-validation-b', 'stay');

    const overlap = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['scope-validation-a', 'scope-validation-b'],
      tasks: [
        {
          toolId: 'scope-validation-a',
          description: 'Edit source',
          declaredFileScope: ['src'],
        },
        {
          toolId: 'scope-validation-b',
          description: 'Edit a child folder',
          declaredFileScope: ['src/components'],
        },
      ],
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('task_scope_overlap');

    const unsafe = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['scope-validation-a'],
      tasks: [
        {
          toolId: 'scope-validation-a',
          description: 'Escape repository scope',
          declaredFileScope: ['../outside.txt'],
        },
      ],
    });
    expect(unsafe.status).toBe(400);
    expect(unsafe.body.error.code).toBe('invalid_task_scope');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_tasks').get()).toEqual({ count: 0 });
    expect(manager.liveCount).toBe(0);
  });

  it('refuses unknown projects and unknown CLI profiles without saving a session', async () => {
    const unknownProject = await authorized('post', '/api/sessions').send({
      projectId: 'missing-project',
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    expect(unknownProject.status).toBe(404);
    expect(unknownProject.body.error.code).toBe('project_not_found');

    const project = await makeProject();
    const unknownTool = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['no-such-tool'],
    });
    expect(unknownTool.status).toBe(400);
    expect(unknownTool.body.error.code).toBe('tool_not_found');

    const sessions = await authorized('get', '/api/sessions');
    expect(sessions.body.sessions).toHaveLength(0);
  });

  it('refuses disabled, launch-unverified, and missing executables', async () => {
    const project = await makeProject();
    addProfile('test-disabled', 'stay', { enabled: false });
    addProfile('test-unverified', 'stay', { verified: false });
    addProfile('test-missing', 'stay', {
      command: path.join(tempDir, 'definitely-missing.exe'),
    });

    const disabled = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-disabled'],
    });
    expect(disabled.status).toBe(409);
    expect(disabled.body.error.code).toBe('tool_not_launchable');

    const unverified = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-unverified'],
    });
    expect(unverified.status).toBe(409);
    expect(unverified.body.error.code).toBe('tool_not_launchable');

    const missing = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-missing'],
    });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('tool_missing');

    const sessions = await authorized('get', '/api/sessions');
    expect(sessions.body.sessions).toHaveLength(0);
  });
});

describe('session lifecycle', () => {
  it('creates a custom session with a default title and launches in the project cwd', async () => {
    const project = await makeProject();
    addProfile('test-stay', 'stay');

    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    expect(created.status).toBe(201);
    expect(created.body.session.mode).toBe('custom');
    expect(created.body.session.title).toMatch(
      new RegExp(`^Runtime Project \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`),
    );

    const sessionId = created.body.session.id as string;
    await waitUntil(async () => {
      const session = await getSession(sessionId);
      return session.status === 'running';
    }, 'Session did not reach running');

    const session = await getSession(sessionId);
    const terminal = session.terminals[0];
    expect(terminal.status).toBe('running');
    expect(isAlive(terminal.pid)).toBe(true);
    expect(session.project.path).toBe(project.path);

    await waitUntil(() => fs.existsSync(evidenceFor('test-stay')), 'Fixture did not start');
    const evidence = JSON.parse(fs.readFileSync(evidenceFor('test-stay'), 'utf8')) as {
      cwd: string;
      pid: number;
    };
    expect(evidence.cwd).toBe(project.path);
    expect(evidence.pid).toBe(terminal.pid);

    const projectList = await authorized('get', '/api/projects');
    expect(projectList.body.projects[0].sessionsCount).toBe(1);
    expect(projectList.body.projects[0].lastUsedAt).toBeTruthy();

    await authorized('post', `/api/sessions/${sessionId}/stop`);
  });

  it('stops and restarts only live terminal handles and exposes no input route', async () => {
    const project = await makeProject();
    addProfile('test-stay', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    const sessionId = created.body.session.id as string;
    const terminalId = created.body.session.terminals[0].id as string;

    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
    const first = (await getSession(sessionId)).terminals[0];
    const firstPid = first.pid as number;

    const stopped = await authorized('post', `/api/terminals/${terminalId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.session.terminals[0].status).toBe('stopped');
    expect(stopped.body.session.terminals[0].lastError).toBe('Stopped by user.');
    await waitUntil(() => !isAlive(firstPid), 'Terminal root process was not stopped');

    const stoppedAgain = await authorized('post', `/api/terminals/${terminalId}/stop`);
    expect(stoppedAgain.status).toBe(409);
    expect(stoppedAgain.body.error.code).toBe('terminal_not_running');

    const restarted = await authorized('post', `/api/terminals/${terminalId}/restart`);
    expect(restarted.status).toBe(200);
    await waitUntil(
      async () => (await getSession(sessionId)).terminals[0].status === 'running',
      'Restarted terminal did not reach running',
    );
    const second = (await getSession(sessionId)).terminals[0];
    expect(second.pid).not.toBe(firstPid);
    expect(second.restartCount).toBe(1);
    expect(isAlive(second.pid)).toBe(true);

    const inputRoute = await authorized('post', `/api/terminals/${terminalId}/input`).send({
      data: 'hello',
    });
    expect(inputRoute.status).toBe(404);

    await authorized('post', `/api/sessions/${sessionId}/stop`);
  });

  it('stops every live terminal from the session endpoint', async () => {
    const project = await makeProject('Runtime Project', true);
    addProfile('test-cap-a', 'stay');
    addProfile('test-cap-b', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-cap-a', 'test-cap-b'],
    });
    const sessionId = created.body.session.id as string;

    await waitUntil(async () => {
      const session = await getSession(sessionId);
      return session.terminals.every((terminal: { status: string }) => terminal.status === 'running');
    }, 'Both terminals did not reach running');
    const pids = (await getSession(sessionId)).terminals.map(
      (terminal: { pid: number }) => terminal.pid,
    );

    const stopped = await authorized('post', `/api/sessions/${sessionId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.session.status).toBe('stopped');
    expect(
      stopped.body.session.terminals.every(
        (terminal: { status: string }) => terminal.status === 'stopped',
      ),
    ).toBe(true);
    for (const pid of pids) await waitUntil(() => !isAlive(pid), `PID ${pid} survived`);

    const idempotent = await authorized('post', `/api/sessions/${sessionId}/stop`);
    expect(idempotent.status).toBe(200);
    expect(idempotent.body.session.status).toBe('stopped');
  }, 20000);

  it('keeps a partially failed session and records the failed terminal honestly', async () => {
    const project = await makeProject('Runtime Project', true);
    addProfile('test-stay', 'stay');
    addProfile('test-exit', 'immediate');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay', 'test-exit'],
    });
    const sessionId = created.body.session.id as string;

    await waitUntil(async () => {
      const session = await getSession(sessionId);
      return (
        session.terminals.some((terminal: { status: string }) => terminal.status === 'error') &&
        session.terminals.some((terminal: { status: string }) => terminal.status === 'running')
      );
    }, 'Partial failure state was not recorded');

    const session = await getSession(sessionId);
    expect(session.status).toBe('running');
    const failed = session.terminals.find(
      (terminal: { status: string }) => terminal.status === 'error',
    );
    expect(['immediate_exit', 'unexpected_exit']).toContain(failed.errorCode);
    expect(failed.exitCode).toBe(7);
    expect(failed.lastError).toBeTruthy();

    const list = await authorized('get', '/api/sessions');
    expect(list.body.sessions).toHaveLength(1);

    await authorized('post', `/api/sessions/${sessionId}/stop`);
  }, 20000);

  it('kills the terminal process tree while a separate sentinel survives', async () => {
    const project = await makeProject();
    addProfile('test-tree', 'tree');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-tree'],
    });
    const sessionId = created.body.session.id as string;
    const terminalId = created.body.session.terminals[0].id as string;

    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
    const terminal = (await getSession(sessionId)).terminals[0];
    const rootPid = terminal.pid as number;
    await waitUntil(
      () => fs.existsSync(evidenceFor('test-tree')),
      'Grandchild pid file was not written',
    );
    const grandchildPid = Number(fs.readFileSync(evidenceFor('test-tree'), 'utf8'));
    expect(isAlive(grandchildPid)).toBe(true);

    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!sentinel.pid) throw new Error('Sentinel did not start.');
    trackedPids.add(sentinel.pid);
    await wait(100);
    expect(isAlive(sentinel.pid)).toBe(true);

    try {
      const stopped = await authorized('post', `/api/terminals/${terminalId}/stop`);
      expect(stopped.status).toBe(200);
      await waitUntil(() => !isAlive(rootPid), 'Root process survived stop');
      await waitUntil(() => !isAlive(grandchildPid), 'Grandchild process survived stop');
      expect(isAlive(sentinel.pid)).toBe(true);
      expect(manager.liveCount).toBe(0);
    } finally {
      killTree(sentinel.pid);
    }
  });

  it('keeps only one live handle per terminal under concurrent restarts', async () => {
    const project = await makeProject();
    addProfile('test-stay', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    const sessionId = created.body.session.id as string;
    const terminalId = created.body.session.terminals[0].id as string;
    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');

    const [first, second] = await Promise.all([
      authorized('post', `/api/terminals/${terminalId}/restart`),
      authorized('post', `/api/terminals/${terminalId}/restart`),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await waitUntil(
      async () => (await getSession(sessionId)).terminals[0].status === 'running',
      'Concurrent restart did not settle to running',
    );
    expect(manager.liveCount).toBe(1);
    expect((await getSession(sessionId)).terminals[0].restartCount).toBe(2);

    await authorized('post', `/api/sessions/${sessionId}/stop`);
  }, 20000);

  it('applies the configured global live-terminal cap without dropping the session', async () => {
    const project = await makeProject('Runtime Project', true);
    addProfile('test-cap-a', 'stay');
    addProfile('test-cap-b', 'stay');
    const capped = new ProcessManager({
      db,
      launcher,
      maxLive: 1,
      confirmMs: 150,
      startingTimeoutMs: 4000,
      stopTimeoutMs: 250,
      forceWaitMs: 2000,
    });
    managers.push(capped);
    const cappedApp = createApp({
      config,
      db,
      token: TOKEN,
      terminalSupport: { status: 'available', detail: 'test-only cap' },
      processManager: capped,
    });

    const created = await authorized('post', '/api/sessions', cappedApp).send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-cap-a', 'test-cap-b'],
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id as string;
    await waitUntil(async () => {
      const response = await authorized('get', `/api/sessions/${sessionId}`, cappedApp);
      return response.body.session.status === 'running';
    }, 'Capped session did not reach running');

    const session = await getSession(sessionId, cappedApp);
    expect(
      session.terminals.some((terminal: { status: string }) => terminal.status === 'running'),
    ).toBe(true);
    const limited = session.terminals.find(
      (terminal: { errorCode: string | null }) => terminal.errorCode === 'terminal_limit',
    );
    expect(limited).toBeTruthy();
    expect(session.terminals).toHaveLength(2);

    await authorized('post', `/api/sessions/${sessionId}/stop`, cappedApp);
  }, 20000);

  it('shuts down owned processes without using SQLite PIDs', async () => {
    const project = await makeProject();
    addProfile('test-stay', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    const sessionId = created.body.session.id as string;
    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
    const pid = (await getSession(sessionId)).terminals[0].pid as number;

    await manager.shutdown();
    await waitUntil(() => !isAlive(pid), 'Shutdown did not stop the owned process');
    const session = await getSession(sessionId);
    expect(session.status).toBe('stopped');
    expect(session.terminals[0].lastError).toBe('Backend shutting down.');
    expect(manager.liveCount).toBe(0);
  });
});

describe('launch readiness and project safety', () => {
  it('uses only launch-ready Quick Start defaults', async () => {
    const project = await makeProject();
    addProfile('test-quick', 'stay', { defaultQuick: true });
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'quick',
    });
    expect(created.status).toBe(201);
    expect(created.body.session.mode).toBe('quick');
    expect(created.body.session.terminals[0].toolProfileId).toBe('test-quick');
    const sessionId = created.body.session.id as string;
    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
    await authorized('post', `/api/sessions/${sessionId}/stop`);

    db.prepare('UPDATE tool_profiles SET default_on_quick_start = 0').run();
    const unavailable = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'quick',
    });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('quick_start_unavailable');
    expect(unavailable.body.error.message).toContain('Quick Start is unavailable');
  });

  it('revalidates the project folder before launch and restart', async () => {
    const project = await makeProject();
    addProfile('test-stay', 'stay');

    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    const sessionId = created.body.session.id as string;
    const terminalId = created.body.session.terminals[0].id as string;
    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
    const firstPid = (await getSession(sessionId)).terminals[0].pid as number;

    const missingWhileRunning = await authorized(
      'post',
      `/api/terminals/${terminalId}/restart`,
    );
    expect(missingWhileRunning.status).toBe(200);
    await authorized('post', `/api/sessions/${sessionId}/stop`);
    await waitUntil(() => !isAlive(firstPid), 'First process survived');

    fs.rmSync(project.path, { recursive: true, force: true });

    const missingRestart = await authorized('post', `/api/terminals/${terminalId}/restart`);
    expect(missingRestart.status).toBe(409);
    expect(missingRestart.body.error.code).toBe('project_path_unavailable');

    const missingCreate = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-stay'],
    });
    expect(missingCreate.status).toBe(409);
    expect(missingCreate.body.error.code).toBe('project_path_unavailable');
    expect(fs.existsSync(evidenceFor('test-stay'))).toBe(true);
    expect(manager.liveCount).toBe(0);
  });

  it('strips DevPilot variables while preserving CLI auth and terminal defaults', async () => {
    const project = await makeProject();
    addProfile('test-env', 'env');
    const previousToken = process.env.DEVPILOT_TOKEN;
    const previousSecret = process.env.DEVPILOT_TEST_SECRET;
    const previousAuth = process.env.ANTHROPIC_AUTH_TOKEN;
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.DEVPILOT_TOKEN = 'must-not-leak';
    process.env.DEVPILOT_TEST_SECRET = 'must-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'cli-auth-token';
    process.env.CLAUDE_CONFIG_DIR = project.path;

    try {
      const created = await authorized('post', '/api/sessions').send({
        projectId: project.id,
        mode: 'custom',
        toolIds: ['test-env'],
      });
      const sessionId = created.body.session.id as string;
      await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');
      await waitUntil(() => fs.existsSync(evidenceFor('test-env')), 'Env evidence missing');
      const evidence = JSON.parse(fs.readFileSync(evidenceFor('test-env'), 'utf8')) as {
        cwd: string;
        token: string | null;
        secret: string | null;
        anthropicToken: string | null;
        claudeConfigDir: string | null;
        hasPath: boolean;
        term: string | null;
      };
      expect(evidence.cwd).toBe(project.path);
      expect(evidence.token).toBeNull();
      expect(evidence.secret).toBeNull();
      expect(evidence.anthropicToken).toBe('cli-auth-token');
      expect(evidence.claudeConfigDir).toBe(project.path);
      expect(evidence.hasPath).toBe(true);
      expect(evidence.term).toBe('xterm-256color');
      await authorized('post', `/api/sessions/${sessionId}/stop`);
    } finally {
      if (previousToken === undefined) delete process.env.DEVPILOT_TOKEN;
      else process.env.DEVPILOT_TOKEN = previousToken;
      if (previousSecret === undefined) delete process.env.DEVPILOT_TEST_SECRET;
      else process.env.DEVPILOT_TEST_SECRET = previousSecret;
      if (previousAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousAuth;
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
  });

  it('buffers bounded output for internal attach without persisting it', async () => {
    const project = await makeProject();
    addProfile('test-output', 'output');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      toolIds: ['test-output'],
    });
    const sessionId = created.body.session.id as string;
    const terminalId = created.body.session.terminals[0].id as string;
    await waitUntil(async () => (await getSession(sessionId)).status === 'running', 'Not running');

    const attachment = manager.attach(terminalId);
    await waitUntil(
      () => attachment.replay().includes('END'),
      'Bounded output did not retain the tail',
    );
    expect(attachment.replay().length).toBeLessThanOrEqual(4096);
    expect(attachment.replay().endsWith('END')).toBe(true);
    expect(() => attachment.write('x'.repeat(64 * 1024 + 1))).toThrow();
    attachment.resize(9999, 9999);
    attachment.resize(Number.NaN, Number.NaN);
    attachment.detach();

    const columns = db
      .prepare('PRAGMA table_info(session_terminals)')
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).not.toContain('output');
    await authorized('post', `/api/sessions/${sessionId}/stop`);
  });
});

describe('isolated agent workspaces', () => {
  it('creates agent-owned branches and task records and rejects conflicting scope updates', async () => {
    const project = await makeProject('Task Branch Project', true);
    addProfile('workspace-task-a', 'stay');
    addProfile('workspace-task-b', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-task-a', 'workspace-task-b'],
      tasks: [
        {
          toolId: 'workspace-task-a',
          description: 'Implement the web view',
          declaredFileScope: ['apps/web'],
          dependencies: ['workspace-task-b'],
        },
        {
          toolId: 'workspace-task-b',
          description: 'Define the shared contract',
          declaredFileScope: ['shared'],
        },
      ],
    });

    expect(created.status).toBe(201);
    const sessionId = created.body.session.id as string;
    const [terminalA, terminalB] = created.body.session.terminals as Array<{
      id: string;
      status: string;
      errorCode: string | null;
      task: {
        description: string;
        declaredFileScope: string[];
        dependencies: string[];
        status: string;
        state: string;
      };
      workspace: {
        path: string;
        baseCommit: string;
        branchName: string;
      };
    }>;
    expect(terminalA.task).toMatchObject({
      description: 'Implement the web view',
      declaredFileScope: ['apps/web'],
      dependencies: [terminalB.id],
      status: 'planned',
    });
    expect(terminalB.task).toMatchObject({
      description: 'Define the shared contract',
      declaredFileScope: ['shared'],
      dependencies: [],
      status: 'planned',
    });
    // Dependent tasks wait for the scheduler instead of racing their dependency.
    expect(terminalA.task?.state).toBe('blocked');
    expect(terminalA.status).toBe('stopped');
    expect(terminalA.errorCode).toBe('awaiting_dependencies');
    expect(terminalB.task?.state).toBe('running');
    expect(terminalA.workspace.branchName).toContain(terminalA.id);
    expect(terminalB.workspace.branchName).toContain(terminalB.id);
    expect(terminalA.workspace.branchName).not.toBe(terminalB.workspace.branchName);
    for (const terminal of [terminalA, terminalB]) {
      const branch = spawnSync(
        'git',
        ['-C', terminal.workspace.path, 'branch', '--show-current'],
        { encoding: 'utf8', windowsHide: true },
      );
      const head = spawnSync(
        'git',
        ['-C', terminal.workspace.path, 'rev-parse', 'HEAD'],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(branch.status).toBe(0);
      expect(branch.stdout.trim()).toBe(terminal.workspace.branchName);
      expect(head.status).toBe(0);
      expect(head.stdout.trim()).toBe(terminal.workspace.baseCommit);
    }

    const liveStatus = await authorized(
      'patch',
      `/api/sessions/${sessionId}/terminals/${terminalB.id}/task`,
    ).send({ status: 'in_progress' });
    expect(liveStatus.status).toBe(200);
    const locked = await authorized(
      'patch',
      `/api/sessions/${sessionId}/terminals/${terminalB.id}/task`,
    ).send({ description: 'Change after launch' });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('task_assignment_locked');
    await authorized('post', `/api/sessions/${sessionId}/stop`);

    const updated = await authorized(
      'patch',
      `/api/sessions/${sessionId}/terminals/${terminalA.id}/task`,
    ).send({
      declaredFileScope: ['apps/web/src'],
      status: 'in_progress',
    });
    expect(updated.status).toBe(200);
    expect(
      updated.body.session.terminals.find(
        (terminal: { id: string }) => terminal.id === terminalA.id,
      ).task,
    ).toMatchObject({
      declaredFileScope: ['apps/web/src'],
      status: 'in_progress',
    });

    const overlap = await authorized(
      'patch',
      `/api/sessions/${sessionId}/terminals/${terminalB.id}/task`,
    ).send({ declaredFileScope: ['apps/web/src/components'] });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('task_scope_overlap');

    const cycle = await authorized(
      'patch',
      `/api/sessions/${sessionId}/terminals/${terminalB.id}/task`,
    ).send({ dependencies: [terminalA.id] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('task_dependency_cycle');
  }, 30000);

  it('launches each CLI in a distinct worktree and preserves work across restart', async () => {
    const project = await makeProject('Runtime Project', true);
    addProfile('workspace-agent-a', 'stay');
    addProfile('workspace-agent-b', 'stay');

    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-agent-a', 'workspace-agent-b'],
    });
    expect(created.status).toBe(201);
    expect(created.body.session.workspaceMode).toBe('isolated');
    const sessionId = created.body.session.id as string;
    const [terminalA, terminalB] = created.body.session.terminals as Array<{
      id: string;
      workspace: { path: string; workingDirectory: string; status: string };
    }>;

    expect(terminalA.workspace.status).toBe('ready');
    expect(terminalB.workspace.status).toBe('ready');
    expect(terminalA.workspace.path).not.toBe(terminalB.workspace.path);
    expect(terminalA.workspace.workingDirectory).not.toBe(
      terminalB.workspace.workingDirectory,
    );

    await waitUntil(async () => {
      const session = await getSession(sessionId);
      return session.terminals.every(
        (terminal: { status: string }) => terminal.status === 'running',
      );
    }, 'Both isolated CLI processes did not reach running');
    await waitUntil(
      () =>
        fs.existsSync(evidenceFor('workspace-agent-a')) &&
        fs.existsSync(evidenceFor('workspace-agent-b')),
      'Both isolated CLI processes did not write their workspace evidence',
    );

    const evidenceA = JSON.parse(fs.readFileSync(evidenceFor('workspace-agent-a'), 'utf8')) as {
      cwd: string;
      pid: number;
    };
    const evidenceB = JSON.parse(fs.readFileSync(evidenceFor('workspace-agent-b'), 'utf8')) as {
      cwd: string;
      pid: number;
    };
    expect(evidenceA.cwd).toBe(terminalA.workspace.workingDirectory);
    expect(evidenceB.cwd).toBe(terminalB.workspace.workingDirectory);

    const sharedName = 'same-name.txt';
    fs.writeFileSync(path.join(terminalA.workspace.workingDirectory, sharedName), 'agent A');
    fs.writeFileSync(path.join(terminalB.workspace.workingDirectory, sharedName), 'agent B');
    fs.writeFileSync(path.join(terminalA.workspace.workingDirectory, 'agent-a.txt'), 'A');
    fs.writeFileSync(path.join(terminalB.workspace.workingDirectory, 'agent-b.txt'), 'B');
    expect(
      fs.readFileSync(path.join(terminalA.workspace.workingDirectory, sharedName), 'utf8'),
    ).toBe('agent A');
    expect(
      fs.readFileSync(path.join(terminalB.workspace.workingDirectory, sharedName), 'utf8'),
    ).toBe('agent B');

    const mainStatus = spawnSync('git', ['-C', project.path, 'status', '--porcelain'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(mainStatus.status).toBe(0);
    expect(mainStatus.stdout.trim()).toBe('');

    const terminalAId = terminalA.id;
    const restarted = await authorized('post', `/api/terminals/${terminalAId}/restart`);
    expect(restarted.status).toBe(200);
    await waitUntil(async () => {
      const session = await getSession(sessionId);
      return session.terminals.find(
        (terminal: { id: string }) => terminal.id === terminalAId,
      )?.status === 'running';
    }, 'Restarted isolated CLI process did not reach running');

    const afterRestart = (await getSession(sessionId)).terminals.find(
      (terminal: { id: string }) => terminal.id === terminalAId,
    );
    expect(afterRestart.workspace.path).toBe(terminalA.workspace.path);
    expect(
      fs.readFileSync(path.join(terminalA.workspace.workingDirectory, sharedName), 'utf8'),
    ).toBe('agent A');
    await authorized('post', `/api/sessions/${sessionId}/stop`);
  }, 30000);

  it('creates shared sessions without inspecting Git and adds multiple terminals in the same folder without stopping existing PTYs', async () => {
    const project = await makeProject('Shared Folder Project', false);
    addProfile('workspace-shared-a', 'stay');
    addProfile('workspace-shared-b', 'stay');
    addProfile('workspace-shared-c', 'stay');

    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['workspace-shared-a'],
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id as string;
    expect(created.body.session.workspaceMode).toBe('shared');
    expect(created.body.session.terminals[0].workspace).toBeNull();
    await waitUntil(
      async () => (await getSession(sessionId)).terminals[0].status === 'running',
      'Initial shared-folder terminal did not start',
    );
    const pidA = (await getSession(sessionId)).terminals[0].pid as number;

    const addedB = await authorized('post', `/api/sessions/${sessionId}/terminals`).send({
      toolId: 'workspace-shared-b',
    });
    expect(addedB.status).toBe(201);
    expect(addedB.body.session.workspaceMode).toBe('shared');
    expect(addedB.body.session.terminals).toHaveLength(2);
    expect(addedB.body.session.terminals.every((terminal: { workspace: unknown }) => terminal.workspace === null)).toBe(true);
    expect(
      (db.prepare('SELECT workspace_mode FROM sessions WHERE id = ?').get(sessionId) as { workspace_mode: string }).workspace_mode,
    ).toBe('shared');
    await waitUntil(
      () => fs.existsSync(evidenceFor('workspace-shared-b')),
      'Second shared-folder terminal did not start',
    );
    const evidenceB = JSON.parse(fs.readFileSync(evidenceFor('workspace-shared-b'), 'utf8')) as { cwd: string };
    expect(evidenceB.cwd).toBe(project.path);
    const stillLiveA = (await getSession(sessionId)).terminals[0];
    expect(stillLiveA.pid).toBe(pidA);
    expect(isAlive(pidA)).toBe(true);

    const addedC = await authorized('post', `/api/sessions/${sessionId}/terminals`).send({
      toolId: 'workspace-shared-c',
    });
    expect(addedC.status).toBe(201);
    await waitUntil(
      () => fs.existsSync(evidenceFor('workspace-shared-c')),
      'Third shared-folder terminal did not start',
    );
    const evidenceC = JSON.parse(fs.readFileSync(evidenceFor('workspace-shared-c'), 'utf8')) as { cwd: string };
    expect(evidenceC.cwd).toBe(project.path);
    const all = await getSession(sessionId);
    expect(all.terminals).toHaveLength(3);
    expect(all.terminals.every((terminal: { workspace: unknown }) => terminal.workspace === null)).toBe(true);
    expect(all.terminals[0].pid).toBe(pidA);
    expect(isAlive(pidA)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workspaces').get()).toEqual({ count: 0 });
    await authorized('post', `/api/sessions/${sessionId}/stop`);
  }, 30000);

  it('adds a terminal to an isolated session in a new owned worktree', async () => {
    const project = await makeProject('Add Isolated Terminal', true);
    addProfile('workspace-add-a', 'stay');
    addProfile('workspace-add-b', 'stay');
    addProfile('workspace-add-c', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-add-a', 'workspace-add-b'],
    });
    expect(created.status).toBe(201);
    const sessionId = created.body.session.id as string;
    await waitUntil(
      async () =>
        (await getSession(sessionId)).terminals.every(
          (terminal: { status: string }) => terminal.status === 'running',
        ),
      'Initial isolated terminals did not start',
    );

    const added = await authorized('post', `/api/sessions/${sessionId}/terminals`).send({
      toolId: 'workspace-add-c',
    });
    expect(added.status).toBe(201);
    const terminals = added.body.session.terminals as Array<{
      id: string;
      toolProfileId: string;
      status: string;
      workspace: { path: string; workingDirectory: string; status: string };
    }>;
    expect(terminals).toHaveLength(3);
    expect(terminals.every((terminal) => terminal.workspace.status === 'ready')).toBe(true);
    expect(new Set(terminals.map((terminal) => terminal.workspace.path)).size).toBe(3);
    const newTerminal = terminals.find(
      (terminal) => terminal.toolProfileId === 'workspace-add-c',
    )!;
    await waitUntil(
      () => fs.existsSync(evidenceFor('workspace-add-c')),
      'Added CLI process did not start',
    );
    const evidence = JSON.parse(fs.readFileSync(evidenceFor('workspace-add-c'), 'utf8')) as {
      cwd: string;
    };
    expect(evidence.cwd).toBe(newTerminal.workspace.workingDirectory);

    const stopped = await authorized('post', `/api/sessions/${sessionId}/stop`);
    expect(stopped.status).toBe(200);
  }, 30000);

  it('adds an isolated terminal without stopping or reassigning an existing worktree', async () => {
    const project = await makeProject('Add Isolated Terminals', true);
    addProfile('workspace-convert-a', 'stay');
    addProfile('workspace-convert-b', 'stay');
    const created = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-convert-a'],
    });
    const sessionId = created.body.session.id as string;
    const originalTerminalId = created.body.session.terminals[0].id as string;
    await waitUntil(
      async () => (await getSession(sessionId)).terminals[0].status === 'running',
      'Single isolated CLI terminal did not start',
    );
    const originalBeforeAdd = (await getSession(sessionId)).terminals[0];
    const originalPid = originalBeforeAdd.pid as number;

    const added = await authorized('post', `/api/sessions/${sessionId}/terminals`).send({
      toolId: 'workspace-convert-b',
    });
    expect(added.status).toBe(201);
    expect(added.body.session.workspaceMode).toBe('isolated');
    const original = added.body.session.terminals.find(
      (terminal: { id: string }) => terminal.id === originalTerminalId,
    );
    const newTerminal = added.body.session.terminals.find(
      (terminal: { toolProfileId: string }) =>
        terminal.toolProfileId === 'workspace-convert-b',
    );
    expect(original.workspace.status).toBe('ready');
    expect(newTerminal.workspace.status).toBe('ready');
    expect(original.workspace.path).toBe(originalBeforeAdd.workspace.path);
    expect(original.workspace.workingDirectory).toBe(originalBeforeAdd.workspace.workingDirectory);
    expect(original.pid).toBe(originalPid);
    expect(isAlive(originalPid)).toBe(true);
    expect(original.restartCount).toBe(originalBeforeAdd.restartCount);

    fs.rmSync(evidenceFor('workspace-convert-a'), { force: true });
    const restarted = await authorized(
      'post',
      `/api/sessions/${sessionId}/terminals/${originalTerminalId}/restart`,
    );
    expect(restarted.status).toBe(200);
    await waitUntil(
      () => fs.existsSync(evidenceFor('workspace-convert-a')),
      'Original CLI did not restart',
    );
    const restartedEvidence = JSON.parse(
      fs.readFileSync(evidenceFor('workspace-convert-a'), 'utf8'),
    ) as { cwd: string };
    expect(restartedEvidence.cwd).toBe(original.workspace.workingDirectory);
    await authorized('post', `/api/sessions/${sessionId}/stop`);
  }, 30000);

  it('allows multiple shared-folder terminals outside Git and does not create worktree records', async () => {
    const project = await makeProject('Shared Non-Git Project', false);
    addProfile('workspace-non-git-shared-a', 'stay');
    addProfile('workspace-non-git-shared-b', 'stay');
    const response = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['workspace-non-git-shared-a', 'workspace-non-git-shared-b'],
    });
    expect(response.status).toBe(201);
    expect(response.body.session.workspaceMode).toBe('shared');
    expect(response.body.session.terminals.every((terminal: { workspace: unknown }) => terminal.workspace === null)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workspaces').get()).toEqual({ count: 0 });
    await authorized('post', `/api/sessions/${response.body.session.id}/stop`);
  }, 20000);

  it('refuses multi-CLI isolated sessions outside a Git repository without saving records or launching processes', async () => {
    const project = await makeProject('Non-Git Project', false);
    addProfile('workspace-non-git-a', 'stay');
    addProfile('workspace-non-git-b', 'stay');

    const response = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-non-git-a', 'workspace-non-git-b'],
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('project_not_git');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(manager.liveCount).toBe(0);
  });

  it('refuses multi-CLI sessions when the main repository has uncommitted changes', async () => {
    const project = await makeProject('Dirty Git Project', true);
    const userChange = path.join(project.path, 'user-change.txt');
    fs.writeFileSync(userChange, 'preserve this change');
    addProfile('workspace-dirty-a', 'stay');
    addProfile('workspace-dirty-b', 'stay');

    const response = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['workspace-dirty-a', 'workspace-dirty-b'],
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('project_git_dirty');
    expect(fs.readFileSync(userChange, 'utf8')).toBe('preserve this change');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(manager.liveCount).toBe(0);
  });
});

describe('startup reconciliation and migration', () => {
  it('marks stale live rows stopped and unavailable without killing their stored PID', async () => {
    const project = await makeProject();
    addProfile('test-recon', 'stay');
    const now = new Date().toISOString();
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!sentinel.pid) throw new Error('Sentinel did not start.');
    trackedPids.add(sentinel.pid);

    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, mode, created_at, updated_at)
       VALUES ('stale-session', 'Stale', ?, 'running', 'custom', ?, ?)`,
    ).run(project.id, now, now);
    db.prepare(
      `INSERT INTO session_terminals
         (id, session_id, tool_profile_id, process_status, process_pid, started_at)
       VALUES ('stale-terminal', 'stale-session', 'test-recon', 'running', ?, ?)`,
    ).run(sentinel.pid, now);

    try {
      expect(reconcileStaleTerminals(db)).toBe(1);
      expect(isAlive(sentinel.pid)).toBe(true);
      const row = db
        .prepare('SELECT * FROM session_terminals WHERE id = ?')
        .get('stale-terminal') as {
        process_status: string;
        process_pid: number | null;
        last_error: string;
        error_code: string;
      };
      expect(row.process_status).toBe('stopped');
      expect(row.process_pid).toBeNull();
      expect(row.last_error).toBe('Backend restarted');
      expect(row.error_code).toBe('backend_restarted');
      const session = await getSession('stale-session');
      expect(session.status).toBe('unavailable');
      expect(session.terminals[0].status).toBe('unavailable');
    } finally {
      killTree(sentinel.pid);
    }
  });

  it('migrates a populated v2 database with launch verification and runtime columns', () => {
    const legacyPath = path.join(tempDir, 'legacy-v2.db');
    const now = new Date().toISOString();
    const legacy = new Database(legacyPath);
    legacy.exec(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       );`,
    );
    legacy.exec(migration001.sql);
    legacy.exec(migration002.sql);
    legacy
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
      .run('initial_schema', now);
    legacy
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, ?, ?)')
      .run('project_path_key', now);
    legacy
      .prepare(
        `INSERT INTO projects (id, name, path, path_key, created_at, updated_at)
         VALUES ('legacy-project', 'Legacy', 'C:\\Work\\Legacy', 'c:\\work\\legacy', ?, ?)`,
      )
      .run(now, now);
    legacy
      .prepare(
        `INSERT INTO tool_profiles
           (id, display_name, command, fixed_args_json, enabled, default_on_quick_start, last_status, notes)
         VALUES ('claude', 'Claude', 'C:\\claude.exe', '[]', 1, 1, 'available', 'legacy')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO tool_profiles
           (id, display_name, command, fixed_args_json, enabled, default_on_quick_start, last_status, notes)
         VALUES ('opencode', 'OpenCode', 'C:\\opencode.exe', '[]', 0, 0, 'unknown', 'legacy')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO sessions (id, title, project_id, status, created_at, updated_at)
         VALUES ('legacy-session', 'Legacy session', 'legacy-project', 'running', ?, ?)`,
      )
      .run(now, now);
    legacy
      .prepare(
        `INSERT INTO session_terminals
           (id, session_id, tool_profile_id, process_status, process_pid, started_at)
         VALUES ('legacy-terminal', 'legacy-session', 'claude', 'running', 999, ?)`,
      )
      .run(now);
    legacy.close();

    const migrated = openDatabase(legacyPath);
    expect(migrated.pragma('user_version', { simple: true })).toBe(11);
    const tools = migrated
      .prepare('SELECT id, launch_verified FROM tool_profiles ORDER BY id')
      .all() as { id: string; launch_verified: number }[];
    expect(tools).toEqual([
      { id: 'claude', launch_verified: 1 },
      { id: 'opencode', launch_verified: 0 },
    ]);
    const session = migrated
      .prepare('SELECT mode, status, workspace_mode FROM sessions WHERE id = ?')
      .get('legacy-session') as { mode: string; status: string; workspace_mode: string | null };
    expect(session).toEqual({ mode: 'custom', status: 'running', workspace_mode: null });
    const terminal = migrated
      .prepare(
        'SELECT process_status, process_pid, error_code, restart_count FROM session_terminals WHERE id = ?',
      )
      .get('legacy-terminal') as {
      process_status: string;
      process_pid: number;
      error_code: string | null;
      restart_count: number;
    };
    expect(terminal).toEqual({
      process_status: 'running',
      process_pid: 999,
      error_code: null,
      restart_count: 0,
    });
    expect(
      (migrated.prepare("SELECT workspace_mode FROM sessions WHERE id = 'legacy-session'").get() as { workspace_mode: string | null }).workspace_mode,
    ).toBeNull();
    migrated.close();
  });
});
