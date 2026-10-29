import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentTaskSummary,
  SessionOrchestrationSummary,
  SessionSummary,
} from '../../shared/api-types.cjs';
import protocol from '../../shared/protocol.cjs';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db/types';
import { OrchestrationService, DEFAULT_INTEGRATION_BRANCH } from '../src/services/orchestration';
import type { OwnedProcess, ProcessExit, ProcessLauncher } from '../src/services/processLauncher';
import { ProcessManager } from '../src/services/processManager';
import { SessionService } from '../src/services/sessions';
import { seedToolProfiles } from '../src/services/toolRegistry';

const { TOKEN_HEADER } = protocol;
const TOKEN = 'test-token-coordination-0123456789';

let tempDir: string;
let db: Db;
let config: AppConfig;
let app: ReturnType<typeof createApp>;
let manager: ProcessManager;
let sessionService: SessionService;
let orchestration: OrchestrationService;
let scriptPath: string;
let validationScript: string;
const trackedPids = new Set<number>();

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 12_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await wait(60);
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

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function gitResult(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-coordination-'));
  config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_RUNTIME_DIR: path.join(tempDir, 'runtime'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
    DEVPILOT_MAX_TERMINALS: '10',
    DEVPILOT_MAX_TERMINALS_PER_SESSION: '4',
    DEVPILOT_MAX_CONCURRENT_AGENTS: '3',
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  db.prepare(`
    UPDATE tool_profiles
    SET enabled = 0, default_on_quick_start = 0, launch_verified = 0, last_status = 'unknown'
  `).run();

  scriptPath = path.join(tempDir, 'agent-fixture.cjs');
  fs.writeFileSync(
    scriptPath,
    `const fs = require('node:fs');
const evidence = process.argv[2];
const log = process.argv[3];
const lifetime = Number(process.argv[4] || 5000);
const payload = JSON.stringify({ cwd: process.cwd(), pid: process.pid });
fs.writeFileSync(evidence, payload);
if (log) fs.appendFileSync(log, payload + String.fromCharCode(10));
process.stdout.write('agent-ready' + String.fromCharCode(10));
setTimeout(() => process.exit(0), lifetime);
`,
  );

  validationScript = path.join(tempDir, 'validation-fixture.cjs');
  fs.writeFileSync(
    validationScript,
    `const fs = require('node:fs');
const mode = process.argv[2];
if (mode === 'fail') { console.error('assertion failed'); process.exit(2); }
process.exit(0);
`,
  );

  manager = new ProcessManager({
    db,
    launcher: createChildProcessLauncher(),
    maxLive: 10,
    confirmMs: 150,
    startingTimeoutMs: 4000,
    stopTimeoutMs: 250,
    forceWaitMs: 2000,
    bufferLimit: 4096,
  });
  sessionService = new SessionService(db, manager, 4, config.runtimeDir);
  orchestration = new OrchestrationService({
    db,
    sessions: sessionService,
    maxConcurrentAgents: 3,
    maxLiveTerminals: 10,
    runtimeDir: config.runtimeDir,
  });
  app = createApp({
    config,
    db,
    token: TOKEN,
    terminalSupport: { status: 'available', detail: 'test-only child-process registry' },
    processManager: manager,
    sessionService,
    orchestrationService: orchestration,
  });
});

afterEach(async () => {
  try {
    await manager.shutdown();
  } catch {
    // Best-effort cleanup.
  }
  for (const pid of trackedPids) killTree(pid);
  trackedPids.clear();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function authorized(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  target = app,
) {
  return request(target)[method](url).set(TOKEN_HEADER, TOKEN);
}

function addProfile(id: string, lifetime = 5_000): void {
  db.prepare(
    `INSERT INTO tool_profiles (
       id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
       launch_verified, last_status, last_checked_at, notes
     ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, 'Test-only agent profile.')`,
  ).run(
    id,
    id.toUpperCase(),
    process.execPath,
    JSON.stringify([
      scriptPath,
      path.join(tempDir, `${id}.json`),
      path.join(tempDir, `${id}.log`),
      String(lifetime),
    ]),
    new Date().toISOString(),
  );
}

function evidencePath(profileId: string): string {
  return path.join(tempDir, `${profileId}.json`);
}

function readLogLines(profileId: string): Array<{ cwd: string; pid: number }> {
  const logPath = path.join(tempDir, `${profileId}.log`);
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd: string; pid: number });
}

async function makeProject(name: string): Promise<{ id: string; path: string }> {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { recursive: true });
  const init = spawnSync('git', ['init', '--quiet', '-b', 'main', directory], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  for (const [key, value] of [
    ['user.name', 'DevPilot Test'],
    ['user.email', 'devpilot-test@example.invalid'],
  ]) {
    spawnSync('git', ['-C', directory, 'config', key, value], { encoding: 'utf8' });
  }
  fs.mkdirSync(path.join(directory, 'server'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'web'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# Fixture project\n');
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { build: 'tsc', test: 'vitest' } }, null, 2),
  );
  fs.writeFileSync(path.join(directory, 'server', 'app.ts'), 'export const app = 1;\n');
  fs.writeFileSync(path.join(directory, 'web', 'app.ts'), 'export const web = 1;\n');
  fs.writeFileSync(path.join(directory, 'src', 'a.txt'), 'a\n');
  git(directory, ['add', '-A']);
  git(directory, ['commit', '-qm', 'Initial']);

  const canonical = fs.realpathSync.native(directory);
  const response = await authorized('post', '/api/projects').send({
    path: canonical,
    name,
  });
  expect(response.status).toBe(201);
  return { id: response.body.project.id as string, path: canonical };
}

interface TaskDraft {
  description?: string;
  declaredFileScope?: string[];
  dependencies?: string[];
}

interface SessionBody {
  session: SessionSummary;
}

async function createSession(
  projectId: string,
  toolIds: string[],
  tasks: TaskDraft[] = [],
  workspaceMode: 'shared' | 'isolated' = 'isolated',
): Promise<SessionBody['session']> {
  const response = await authorized('post', '/api/sessions').send({
    projectId,
    mode: 'custom',
    workspaceMode,
    toolIds,
    tasks: toolIds.map((toolId, index) => ({ toolId, ...(tasks[index] ?? {}) })),
  });
  if (response.status !== 201) {
    throw new Error(`Session creation failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.session as SessionBody['session'];
}

async function getTask(taskId: string): Promise<AgentTaskSummary> {
  const response = await authorized('get', `/api/orchestration/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.body.task as AgentTaskSummary;
}

async function getSummary(sessionId: string): Promise<SessionOrchestrationSummary> {
  const response = await authorized('get', `/api/orchestration/sessions/${sessionId}`);
  expect(response.status).toBe(200);
  return response.body.orchestration as SessionOrchestrationSummary;
}

async function configure(projectId: string, input: Record<string, unknown>): Promise<void> {
  const response = await authorized('put', '/api/orchestration/settings').send({
    projectId,
    ...input,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function stopSession(sessionId: string): Promise<void> {
  const response = await authorized('post', `/api/sessions/${sessionId}/stop`);
  expect(response.status).toBe(200);
}

function commitFile(
  worktreePath: string,
  relativePath: string,
  content: string,
  message = 'agent change',
): void {
  const fullPath = path.join(worktreePath, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '-qm', message]);
}

async function completeTask(
  taskId: string,
  summary = 'Committed the requested change on the task branch.',
): Promise<AgentTaskSummary> {
  const response = await authorized('post', `/api/orchestration/tasks/${taskId}/complete`).send({
    summary,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.task as AgentTaskSummary;
}

async function integrateTask(
  taskId: string,
  body: Record<string, unknown> = { acknowledgeNoValidation: true },
) {
  return authorized('post', `/api/orchestration/tasks/${taskId}/integrate`).send(body);
}

function taskFor(session: SessionSummary, index = 0) {
  const terminal = session.terminals[index]!;
  return { terminal, taskId: terminal.id, worktree: terminal.workspace!.workingDirectory };
}

describe('workflow planning from one prompt', () => {
  it('generates scoped tasks, assigns verified CLIs, and starts only independent work', async () => {
    addProfile('wf-a');
    addProfile('wf-b');
    db.prepare(
      `INSERT INTO tool_profiles (
         id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
         launch_verified, last_status, last_checked_at, notes
       ) VALUES ('wf-unverified', 'WF UNVERIFIED', ?, '[]', 1, 0, 0, 'unknown', ?, 'Not verified.')`,
    ).run(process.execPath, new Date().toISOString());
    const project = await makeProject('Workflow Project');

    const workflowInput = {
      projectId: project.id,
      prompt: 'Add a health check API in the server then display it in the web dashboard',
      maxTasks: 2,
    };
    const preview = await authorized('post', '/api/orchestration/workflows/preview').send(workflowInput);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });

    const response = await authorized('post', '/api/orchestration/workflows').send({
      ...workflowInput,
      planFingerprint: preview.body.planFingerprint,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const session = response.body.session as SessionSummary;
    expect(session.workspaceMode).toBe('isolated');
    expect(session.terminals).toHaveLength(2);
    const plan = response.body.plan as {
      tasks: Array<{
        agentName: string;
        declaredFileScope: string[];
        dependencies: number[];
        rationale: string;
      }>;
    };
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]!.declaredFileScope).toEqual(['server']);
    expect(plan.tasks[1]!.declaredFileScope).toEqual(['web']);
    expect(plan.tasks[1]!.dependencies).toEqual([0]);
    expect(plan.tasks.map((task) => task.agentName).sort()).toEqual(['WF-A', 'WF-B']);
    const assignedIds = plan.tasks.map((task) => task.agentName);
    expect(assignedIds).not.toContain('WF UNVERIFIED');

    const [first, second] = session.terminals;
    await waitUntil(
      () => fs.existsSync(evidencePath('wf-a')),
      'The first workflow task never started',
    );
    expect((await getTask(first!.id)).state).toBe('running');
    expect((await getTask(second!.id)).state).toBe('blocked');
    expect((await getTask(second!.id)).blockedReason).toContain('dependenc');
    expect(fs.existsSync(evidencePath('wf-b'))).toBe(false);

    const summary = await getSummary(session.id);
    expect(summary.workflow).not.toBeNull();
    expect(summary.workflow!.plan.tasks).toHaveLength(2);
    expect(summary.workflow!.status).toBe('running');
    expect(summary.waiting.map((entry) => entry.taskId)).toContain(second!.id);
    expect(summary.leases.map((lease) => lease.path)).toEqual(['server']);

    await stopSession(session.id);
    commitFile(first!.workspace!.workingDirectory, 'server/health.ts', 'export const ok = true;\n');
    await completeTask(first!.id);
    const integrated = await integrateTask(first!.id);
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);

    await waitUntil(
      () => fs.existsSync(evidencePath('wf-b')),
      'The dependent workflow task never started after integration',
    );
    const dependentTask = await getTask(second!.id);
    expect(dependentTask.state).toBe('running');
    // The dependency commit is present in the dependent worktree.
    expect(
      fs.readFileSync(path.join(second!.workspace!.workingDirectory, 'server', 'health.ts'), 'utf8'),
    ).toContain('export const ok');
    const after = await getSummary(session.id);
    expect(after.leases.some((lease) => lease.path === 'web')).toBe(true);
    expect(after.leases.some((lease) => lease.path === 'server')).toBe(false);
  }, 60_000);

  it('starts a reviewed plan exactly once under simultaneous requests', async () => {
    addProfile('once-a');
    addProfile('once-b');
    const project = await makeProject('Single Start');
    const workflowInput = {
      projectId: project.id,
      prompt: 'Add a health check API in the server then display it in the web dashboard',
      maxTasks: 2,
    };
    const preview = await authorized('post', '/api/orchestration/workflows/preview').send(workflowInput);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const reviewed = {
      ...workflowInput,
      planFingerprint: preview.body.planFingerprint as string,
    };

    const responses = await Promise.all([
      authorized('post', '/api/orchestration/workflows').send(reviewed),
      authorized('post', '/api/orchestration/workflows').send(reviewed),
    ]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses, JSON.stringify(responses.map((response) => response.body))).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect(rejected.body.error.code).toBe('workflow_start_in_progress');

    // One reviewed plan created exactly one session and one workflow run.
    expect(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 1 });
    const started = responses.find((response) => response.status === 201)!;
    expect(started.body.session.terminals).toHaveLength(2);
    expect(started.body.schedule.scheduled).toHaveLength(1);
  }, 60_000);
});

describe('file-level coordination', () => {
  it('runs two tasks with distinct files concurrently', async () => {
    addProfile('distinct-a');
    addProfile('distinct-b');
    const project = await makeProject('Distinct Files');
    const session = await createSession(project.id, ['distinct-a', 'distinct-b'], [
      { description: 'Write file one', declaredFileScope: ['src/one.txt'] },
      { description: 'Write file two', declaredFileScope: ['src/two.txt'] },
    ]);
    await waitUntil(
      () =>
        fs.existsSync(evidencePath('distinct-a')) && fs.existsSync(evidencePath('distinct-b')),
      'Both independent tasks should have started',
    );
    const summary = await getSummary(session.id);
    expect(summary.leases).toHaveLength(2);
    expect(summary.leases.map((lease) => lease.path).sort()).toEqual([
      'src/one.txt',
      'src/two.txt',
    ]);
    expect(new Set(summary.leases.map((lease) => lease.taskId)).size).toBe(2);
    expect(summary.tasks.every((task) => task.state === 'running')).toBe(true);
  }, 30_000);

  it('makes the second claim wait, then resumes it automatically after integration', async () => {
    addProfile('lease-owner');
    addProfile('lease-waiter');
    const project = await makeProject('Same File');
    const owner = await createSession(project.id, ['lease-owner'], [
      { description: 'Own the shared file', declaredFileScope: ['src/shared.txt'] },
    ]);
    const ownerTask = taskFor(owner).taskId;

    const waiter = await createSession(project.id, ['lease-waiter'], [
      { description: 'Also needs the shared file', declaredFileScope: ['src/shared.txt'] },
    ]);
    const waiterTask = taskFor(waiter).taskId;
    const waiting = await getTask(waiterTask);
    expect(waiting.state).toBe('blocked');
    expect(waiting.waitKind).toBe('files');
    expect(waiting.blockedReason).toContain('src/shared.txt');
    expect(waiting.blockedReason).toContain('file ownership');
    expect(fs.existsSync(evidencePath('lease-waiter'))).toBe(false);

    // A second schedule request must not duplicate the waiting CLI.
    await orchestration.scheduleAll();
    await orchestration.scheduleAll();
    expect(fs.existsSync(evidencePath('lease-waiter'))).toBe(false);
    expect(readLogLines('lease-waiter')).toHaveLength(0);

    await stopSession(owner.id);
    commitFile(owner.terminals[0]!.workspace!.workingDirectory, 'src/shared.txt', 'owner\n');
    await completeTask(ownerTask);
    const integrated = await integrateTask(ownerTask);
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);

    await waitUntil(
      () => fs.existsSync(evidencePath('lease-waiter')),
      'The waiting task never resumed after the lease was released',
    );
    expect((await getTask(waiterTask)).state).toBe('running');
    const summary = await getSummary(waiter.id);
    expect(summary.leases).toHaveLength(1);
    expect(summary.leases[0]!.path).toBe('src/shared.txt');
    expect(summary.leases[0]!.taskId).toBe(waiterTask);
  }, 60_000);

  it('treats directory scopes as containing files and rejects traversal paths', async () => {
    addProfile('dir-owner');
    addProfile('dir-waiter');
    const project = await makeProject('Directory Scope');
    const directoryOwner = await createSession(project.id, ['dir-owner'], [
      { description: 'Own the src directory', declaredFileScope: ['src'] },
    ]);
    const nested = await createSession(project.id, ['dir-waiter'], [
      { description: 'Edit a nested file', declaredFileScope: ['src/nested/deep.txt'] },
    ]);
    const nestedTask = taskFor(nested).taskId;
    const blocked = await getTask(nestedTask);
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toContain('src');

    const traversal = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['dir-waiter'],
      tasks: [{ toolId: 'dir-waiter', description: 'Escape', declaredFileScope: ['../escape.txt'] }],
    });
    expect(traversal.status).toBe(400);
    expect(traversal.body.error.code).toBe('invalid_task_scope');

    // Cancelling the owner with no commits releases its files safely.
    await stopSession(directoryOwner.id);
    const cancelled = await authorized(
      'post',
      `/api/orchestration/tasks/${taskFor(directoryOwner).taskId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    await waitUntil(
      () => fs.existsSync(evidencePath('dir-waiter')),
      'The nested-file task never resumed after cancellation released the directory',
    );
  }, 60_000);

  it('replans a conflicting task into genuinely independent scopes', async () => {
    addProfile('replan-owner');
    addProfile('replan-waiter');
    const project = await makeProject('Replan');
    const owner = await createSession(project.id, ['replan-owner'], [
      { description: 'Own shared', declaredFileScope: ['src/shared.txt'] },
    ]);
    const waiter = await createSession(project.id, ['replan-waiter'], [
      {
        description: 'Needs shared and free files',
        declaredFileScope: ['src/shared.txt', 'src/free.txt'],
      },
    ]);
    const waiterTask = taskFor(waiter).taskId;
    expect((await getTask(waiterTask)).state).toBe('blocked');

    orchestration.retryTask(waiterTask);
    await orchestration.scheduleSession(waiter.id);
    await waitUntil(
      () => fs.existsSync(evidencePath('replan-waiter')),
      'The replanned task never started',
    );

    const replanned = await getTask(waiterTask);
    expect(replanned.declaredFileScope).toEqual(['src/free.txt']);
    expect(replanned.deferredScope).toEqual(['src/shared.txt']);
    expect(replanned.replanCount).toBe(1);
    const replans = db
      .prepare('SELECT reason FROM task_replans WHERE task_id = ? ORDER BY created_at')
      .all(waiterTask) as Array<{ reason: string }>;
    expect(replans).toHaveLength(1);
    expect(replans[0]!.reason).toContain('independent writable scope');
    const summary = await getSummary(waiter.id);
    expect(summary.leases.map((lease) => lease.path)).toEqual(['src/free.txt']);
    expect((await getTask(taskFor(owner).taskId)).state).toBe('running');
  }, 60_000);

  it('records out-of-scope changes and keeps ownership until they are resolved', async () => {
    addProfile('scope-owner');
    addProfile('scope-waiter');
    const project = await makeProject('Scope Review');
    const owner = await createSession(project.id, ['scope-owner'], [
      { description: 'Allowed file', declaredFileScope: ['src/allowed.txt'] },
    ]);
    const ownerTask = taskFor(owner).taskId;
    await waitUntil(() => fs.existsSync(evidencePath('scope-owner')), 'Owner never started');
    await stopSession(owner.id);
    commitFile(owner.terminals[0]!.workspace!.workingDirectory, 'src/allowed.txt', 'allowed\n');
    commitFile(owner.terminals[0]!.workspace!.workingDirectory, 'src/unexpected.txt', 'oops\n');
    const completed = await completeTask(ownerTask);
    expect(completed.scopeViolations).toEqual(['src/unexpected.txt']);

    const rejected = await integrateTask(ownerTask);
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('scope_violation');

    const stillOwned = await getSummary(owner.id);
    expect(stillOwned.leases.map((lease) => lease.path)).toEqual(['src/allowed.txt']);
    expect((await getTask(ownerTask)).integrationStatus).toBe('failed');

    // Another task cannot take the files while the failure holds unintegrated work.
    const waiter = await createSession(project.id, ['scope-waiter'], [
      { description: 'Wants allowed.txt', declaredFileScope: ['src/allowed.txt'] },
    ]);
    const waiting = await getTask(taskFor(waiter).taskId);
    expect(waiting.state).toBe('blocked');
    expect(waiting.waitKind).toBe('files');
    expect(fs.existsSync(evidencePath('scope-waiter'))).toBe(false);
  }, 60_000);

  it('does not unblock dependent work when validation fails', async () => {
    addProfile('valid-a');
    addProfile('valid-b');
    const project = await makeProject('Dependency Validation');
    await configure(project.id, {
      validationCommands: [
        {
          name: 'fixture check',
          command: 'node',
          args: [validationScript, 'fail'],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    const workflowInput = {
      projectId: project.id,
      prompt: 'Add a server endpoint then show it on the web page',
      maxTasks: 2,
    };
    const preview = await authorized('post', '/api/orchestration/workflows/preview').send(workflowInput);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const response = await authorized('post', '/api/orchestration/workflows').send({
      ...workflowInput,
      planFingerprint: preview.body.planFingerprint,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const session = response.body.session as SessionSummary;
    const [first, second] = session.terminals;
    await waitUntil(() => fs.existsSync(evidencePath('valid-a')), 'First task never started');
    await stopSession(session.id);
    commitFile(first!.workspace!.workingDirectory, 'server/api.ts', 'export const api = 1;\n');
    const completed = await completeTask(first!.id);
    expect(completed.validationStatus).toBe('failed');
    expect(completed.state).toBe('failed');

    const rejected = await integrateTask(first!.id, {});
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('validation_failed');

    const dependent = await getTask(second!.id);
    expect(dependent.state).toBe('blocked');
    expect(dependent.waitKind).toBe('dependency');
    expect(fs.existsSync(evidencePath('valid-b'))).toBe(false);
    const summary = await getSummary(session.id);
    expect(summary.leases.some((lease) => lease.path === 'web')).toBe(false);

    await configure(project.id, {
      validationCommands: [
        {
          name: 'fixture check',
          command: 'node',
          args: [validationScript, 'pass'],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    const validated = await authorized('post', `/api/orchestration/tasks/${first!.id}/validate`);
    expect(validated.status, JSON.stringify(validated.body)).toBe(200);
    expect(validated.body.task.state).toBe('awaiting_integration');
    const integrated = await integrateTask(first!.id, {});
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);
    await waitUntil(
      () => fs.existsSync(evidencePath('valid-b')),
      'The dependent task never started after the dependency finally integrated',
    );
  }, 70_000);

  it('prevents duplicate leases under simultaneous scheduler requests', async () => {
    addProfile('race-owner');
    addProfile('race-a');
    addProfile('race-b');
    const project = await makeProject('Lease Race');
    const owner = await createSession(project.id, ['race-owner'], [
      { description: 'Temporary owner', declaredFileScope: ['src/race.txt'] },
    ]);
    const first = await createSession(project.id, ['race-a'], [
      { description: 'Race candidate A', declaredFileScope: ['src/race.txt'] },
    ]);
    const second = await createSession(project.id, ['race-b'], [
      { description: 'Race candidate B', declaredFileScope: ['src/race.txt'] },
    ]);
    expect((await getTask(taskFor(first).taskId)).state).toBe('blocked');
    expect((await getTask(taskFor(second).taskId)).state).toBe('blocked');

    await stopSession(owner.id);
    const cancelled = await authorized(
      'post',
      `/api/orchestration/tasks/${taskFor(owner).taskId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    await waitUntil(async () => (await getSummary(owner.id)).leases.length === 0, 'Lease not released');

    orchestration.retryTask(taskFor(first).taskId);
    orchestration.retryTask(taskFor(second).taskId);

    const concurrentService = new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: 3,
      maxLiveTerminals: 10,
      runtimeDir: config.runtimeDir,
    });
    await Promise.all([orchestration.scheduleAll(), concurrentService.scheduleAll()]);

    const states = [
      (await getTask(taskFor(first).taskId)).state,
      (await getTask(taskFor(second).taskId)).state,
    ];
    expect(states.filter((state) => state === 'running')).toHaveLength(1);
    expect(states.filter((state) => state === 'blocked')).toHaveLength(1);
    const activeLeases = db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_task_leases
         WHERE state = 'active' AND path_key = 'src/race.txt'`,
      )
      .get() as { count: number };
    expect(Number(activeLeases.count)).toBe(1);
    // The winner's CLI must report its pid exactly once; the loser never starts.
    await waitUntil(
      () => fs.existsSync(evidencePath('race-a')) || fs.existsSync(evidencePath('race-b')),
      'Neither conflicting candidate launched its CLI',
    );
    const launched = [evidencePath('race-a'), evidencePath('race-b')].filter((file) =>
      fs.existsSync(file),
    );
    expect(launched).toHaveLength(1);
  }, 70_000);

  it('keeps leases, tasks and waiting work intact across restart recovery', async () => {
    addProfile('restart-owner');
    addProfile('restart-waiter');
    const project = await makeProject('Restart Coordination');
    const owner = await createSession(project.id, ['restart-owner'], [
      { description: 'Own across restart', declaredFileScope: ['src/restart.txt'] },
    ]);
    const waiter = await createSession(project.id, ['restart-waiter'], [
      { description: 'Wait across restart', declaredFileScope: ['src/restart.txt'] },
    ]);
    await waitUntil(() => fs.existsSync(evidencePath('restart-owner')), 'Owner never started');

    const leaseCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_task_leases
         WHERE state = 'active' AND path_key = 'src/restart.txt'`,
      )
      .get() as { count: number };
    expect(Number(leaseCount.count)).toBe(1);

    const restarted = new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: 3,
      maxLiveTerminals: 10,
      runtimeDir: config.runtimeDir,
    });
    restarted.recover();
    // Recovery must not release an active lease or duplicate the task.
    const afterRecovery = db
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_task_leases
         WHERE state = 'active' AND path_key = 'src/restart.txt'`,
      )
      .get() as { count: number };
    expect(Number(afterRecovery.count)).toBe(1);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM agent_tasks WHERE terminal_id = ?')
          .get(taskFor(owner).taskId) as { count: number }
      ).count,
    ).toBe(1);
    expect((await getTask(taskFor(waiter).taskId)).state).toBe('blocked');
    expect(fs.existsSync(evidencePath('restart-waiter'))).toBe(false);

    await restarted.scheduleAll();
    expect((await getTask(taskFor(waiter).taskId)).state).toBe('blocked');
    expect(fs.existsSync(evidencePath('restart-waiter'))).toBe(false);
    expect(readLogLines('restart-owner').length).toBe(1);
  }, 60_000);

  it('preserves source branches and worktrees when a merge fails', async () => {
    addProfile('merge-a');
    addProfile('merge-b');
    const project = await makeProject('Merge Failure');
    const first = await createSession(project.id, ['merge-a'], [
      { description: 'First version', declaredFileScope: ['src/conflict.txt'] },
    ]);
    const firstTask = taskFor(first).taskId;
    await waitUntil(() => fs.existsSync(evidencePath('merge-a')), 'First task never started');
    await stopSession(first.id);
    commitFile(first.terminals[0]!.workspace!.workingDirectory, 'src/conflict.txt', 'first\n');
    await completeTask(firstTask);
    expect((await integrateTask(firstTask)).status).toBe(200);
    expect(
      git(project.path, ['show', `${DEFAULT_INTEGRATION_BRANCH}:src/conflict.txt`]),
    ).toBe('first\n');

    const second = await createSession(project.id, ['merge-b'], [
      { description: 'Second version', declaredFileScope: ['src/conflict.txt'] },
    ]);
    const secondTask = taskFor(second).taskId;
    await waitUntil(() => fs.existsSync(evidencePath('merge-b')), 'Second task never started');
    await stopSession(second.id);
    commitFile(second.terminals[0]!.workspace!.workingDirectory, 'src/conflict.txt', 'second\n');
    await completeTask(secondTask);
    const rejected = await integrateTask(secondTask);
    expect(rejected.status).toBe(409);
    expect(['git_conflict', 'overlapping_changes']).toContain(rejected.body.error.code);

    expect(
      git(project.path, ['show', `${DEFAULT_INTEGRATION_BRANCH}:src/conflict.txt`]),
    ).toBe('first\n');
    expect(
      gitResult(project.path, [
        'rev-parse',
        '--verify',
        `refs/heads/${second.terminals[0]!.workspace!.branchName}`,
      ]).status,
    ).toBe(0);
    expect(
      fs.readFileSync(
        path.join(second.terminals[0]!.workspace!.workingDirectory, 'src', 'conflict.txt'),
        'utf8',
      ),
    ).toBe('second\n');
    const summary = await getSummary(second.id);
    expect(summary.leases.map((lease) => lease.path)).toEqual(['src/conflict.txt']);
  }, 60_000);

  it('does not claim hard isolation for Shared Folder mode', async () => {
    addProfile('shared-one');
    addProfile('shared-two');
    const project = await makeProject('Shared Coordination');
    const rejected = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['shared-one', 'shared-two'],
      tasks: [
        { toolId: 'shared-one', description: 'Edit A' },
        { toolId: 'shared-two', description: 'Edit B' },
      ],
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('shared_folder_concurrent_agents');

    const single = await createSession(
      project.id,
      ['shared-one'],
      [{ description: 'Single shared agent', declaredFileScope: ['src/a.txt'] }],
      'shared',
    );
    expect(single.workspaceMode).toBe('shared');
    const summary = await getSummary(single.id);
    expect(summary.sharedFolderRisk).toBe(false);
    expect(summary.leases).toEqual([]);

    const nonGitDir = path.join(tempDir, 'not-a-repository');
    fs.mkdirSync(nonGitDir, { recursive: true });
    const projectResponse = await authorized('post', '/api/projects').send({
      path: nonGitDir,
      name: 'Not a repository',
    });
    expect(projectResponse.status).toBe(201);
    const workflow = await authorized('post', '/api/orchestration/workflows/preview').send({
      projectId: projectResponse.body.project.id,
      prompt: 'Add a feature to this folder',
    });
    expect(workflow.status).toBe(409);
    expect(workflow.body.error.code).toBe('project_not_git');
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?')
          .get(projectResponse.body.project.id) as { count: number }
      ).count,
    ).toBe(0);
  }, 45_000);

  it('pauses and resumes scheduling without releasing ownership', async () => {
    addProfile('pause-a');
    addProfile('pause-b');
    const project = await makeProject('Pause Scheduling');
    const session = await createSession(project.id, ['pause-a'], [
      { description: 'Ready task', declaredFileScope: ['src/pause.txt'] },
    ]);
    await waitUntil(() => fs.existsSync(evidencePath('pause-a')), 'Task never started');
    const paused = await authorized('post', `/api/orchestration/sessions/${session.id}/scheduling`).send({
      paused: true,
    });
    expect(paused.status).toBe(200);
    expect(paused.body.settings.schedulingPaused).toBe(true);
    expect(paused.body.orchestration.schedulingPaused).toBe(true);
    expect(paused.body.orchestration.leases).toHaveLength(1);

    await stopSession(session.id);
    const waiting = await createSession(project.id, ['pause-b'], [
      { description: 'Queued task', declaredFileScope: ['src/pause.txt'] },
    ]);
    const waitingTask = await getTask(taskFor(waiting).taskId);
    expect(waitingTask.state).toBe('blocked');

    const resumed = await authorized('post', `/api/orchestration/sessions/${session.id}/scheduling`).send({
      paused: false,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.body.orchestration.schedulingPaused).toBe(false);
  }, 45_000);
});
