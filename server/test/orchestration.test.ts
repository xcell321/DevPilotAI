import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTaskSummary } from '../../shared/api-types.cjs';
import protocol from '../../shared/protocol.cjs';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db/types';
import { updateBranchRef } from '../src/services/gitReview';
import { OrchestrationService, DEFAULT_INTEGRATION_BRANCH } from '../src/services/orchestration';
import type { OwnedProcess, ProcessExit, ProcessLauncher } from '../src/services/processLauncher';
import { ProcessManager } from '../src/services/processManager';
import { SessionService } from '../src/services/sessions';
import { seedToolProfiles } from '../src/services/toolRegistry';

const { TOKEN_HEADER } = protocol;
const TOKEN = 'test-token-orchestration-0123456789';

interface SessionBody {
  session: {
    id: string;
    workspaceMode: 'shared' | 'isolated' | null;
    terminals: Array<{
      id: string;
      toolProfileId: string;
      status: string;
      errorCode: string | null;
      workspace: { path: string; workingDirectory: string; branchName: string } | null;
      task: AgentTaskSummary | null;
    }>;
  };
}

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
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await wait(50);
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
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-orchestration-'));
  config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_RUNTIME_DIR: path.join(tempDir, 'runtime'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
    DEVPILOT_MAX_TERMINALS: '8',
    DEVPILOT_MAX_TERMINALS_PER_SESSION: '4',
    DEVPILOT_MAX_CONCURRENT_AGENTS: '2',
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  db.prepare('UPDATE tool_profiles SET default_on_quick_start = 0').run();

  scriptPath = path.join(tempDir, 'agent-fixture.cjs');
  fs.writeFileSync(
    scriptPath,
    `const fs = require('node:fs');
const evidence = process.argv[2];
const log = process.argv[3];
const lifetime = Number(process.argv[4] || 700);
const payload = JSON.stringify({ cwd: process.cwd(), pid: process.pid });
fs.writeFileSync(evidence, payload);
if (log) fs.appendFileSync(log, payload + '\\n');
process.stdout.write('agent-ready\\n');
setTimeout(() => process.exit(0), lifetime);
`,
  );

  validationScript = path.join(tempDir, 'validation-fixture.cjs');
  fs.writeFileSync(
    validationScript,
    `const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const mode = process.argv[2];
const marker = process.argv[3];
if (marker) fs.appendFileSync(marker, process.cwd() + String.fromCharCode(10));
if (mode === 'fail') { console.error('assertion failed'); process.exit(2); }
else if (mode === 'slow') { setTimeout(() => process.exit(0), 8000); }
else if (mode === 'combined' || mode === 'merge-only-fail') {
  const project = process.argv[4];
  const branch = process.argv[5];
  const expected = process.argv.slice(6);
  for (const file of expected) {
    if (!fs.existsSync(file)) { console.error('missing candidate file ' + file); process.exit(3); }
  }
  if (mode === 'combined') {
    const shown = spawnSync('git', ['-C', project, 'show', branch + ':' + expected[expected.length - 1]], { encoding: 'utf8' });
    if (shown.status === 0) { console.error('target branch already contains the candidate'); process.exit(4); }
    process.exit(0);
  }
  const parents = spawnSync('git', ['-C', '.', 'rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).stdout.trim().split(' ');
  if (parents.length > 2) { console.error('combined candidate assertion failed'); process.exit(5); }
  process.exit(0);
}
else { process.exit(0); }
`,
  );

  manager = new ProcessManager({
    db,
    launcher: createChildProcessLauncher(),
    maxLive: 8,
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
    maxConcurrentAgents: 2,
    maxLiveTerminals: 8,
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

function addProfile(id: string, lifetime = 700): { evidence: string; log: string } {
  const evidence = path.join(tempDir, `${id}.json`);
  const log = path.join(tempDir, `${id}.log`);
  db.prepare(
    `INSERT INTO tool_profiles (
       id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
       launch_verified, last_status, last_checked_at, notes
     ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, 'Test-only agent profile.')`,
  ).run(
    id,
    id,
    process.execPath,
    JSON.stringify([scriptPath, evidence, log, String(lifetime)]),
    new Date().toISOString(),
  );
  return { evidence, log };
}

function profileEvidence(id: string): string {
  return path.join(tempDir, `${id}.json`);
}

function profileLog(id: string): string {
  return path.join(tempDir, `${id}.log`);
}

function readLogLines(id: string): Array<{ cwd: string; pid: number }> {
  const logPath = profileLog(id);
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { cwd: string; pid: number });
}

async function makeProject(name = 'Orchestration Project'): Promise<{
  id: string;
  path: string;
}> {
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
    const configResult = spawnSync('git', ['-C', directory, 'config', key, value], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (configResult.status !== 0) throw new Error(configResult.stderr);
  }
  fs.writeFileSync(path.join(directory, 'README.md'), '# Base project\n');
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'src', 'a.txt'), 'a\n');    fs.writeFileSync(path.join(directory, 'protected.txt'), 'protected\n');
    fs.writeFileSync(path.join(directory, 'harness.config.json'), '{}\n');
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

async function getLogs(taskId: string) {
  const response = await authorized('get', `/api/orchestration/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.body.logs as {
    validations: Array<{
      status: string;
      name: string;
      exitCode: number | null;
      output: string;
      phase: string;
    }>;
    integrations: Array<{
      state: string;
      reason: string | null;
      mergeCommit: string | null;
      candidateCommit: string | null;
      validationSummary: string | null;
      targetCommitBefore: string | null;
      attempt: number;
    }>;
  };
}

async function configure(
  projectId: string,
  input: Record<string, unknown>,
): Promise<void> {
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

async function waitForAgentExit(sessionId: string, terminalId: string): Promise<void> {
  await waitUntil(async () => {
    const response = await authorized('get', `/api/sessions/${sessionId}`);
    const terminal = (response.body.session.terminals as Array<{ id: string; status: string }>).find(
      (entry) => entry.id === terminalId,
    );
    return terminal?.status === 'exited' || terminal?.status === 'stopped';
  }, 'The agent CLI did not exit before completion');
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

function targetTreeFile(projectPath: string, file: string): string {
  return git(projectPath, ['show', `${DEFAULT_INTEGRATION_BRANCH}:${file}`]);
}

describe('workflow review and start', () => {
  it('previews without side effects and starts only a matching reviewed plan', async () => {
    addProfile('workflow-review-agent');
    const project = await makeProject('Reviewed Workflow Project');

    const preview = await authorized('post', '/api/orchestration/workflows/preview').send({
      projectId: project.id,
      prompt: 'Add a useful project health check.',
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.plan.tasks).toHaveLength(1);
    expect(preview.body.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get()).toEqual({ count: 0 });

    const stale = await authorized('post', '/api/orchestration/workflows').send({
      projectId: project.id,
      prompt: 'Add a useful project health check.',
      planFingerprint: '0'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('workflow_plan_changed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });

    const started = await authorized('post', '/api/orchestration/workflows').send({
      projectId: project.id,
      prompt: 'Add a useful project health check.',
      planFingerprint: preview.body.planFingerprint,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.workflow.status).toBe('running');
    expect(started.body.session.project.id).toBe(project.id);
    expect(started.body.session.workspaceMode).toBe('isolated');
    expect(started.body.plan).toEqual(preview.body.plan);
    expect(started.body.schedule.scheduled).toHaveLength(1);
    expect(started.body.session.terminals[0].workspace.status).toBe('ready');
    expect(db.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get()).toEqual({ count: 1 });
  }, 30_000);
});

describe('task scheduling and dependencies', () => {
  it('starts a dependent task only after its dependency is integrated', async () => {
    addProfile('dep-agent-a');
    addProfile('dep-agent-b');
    const project = await makeProject('Dependency Project');
    const session = await createSession(
      project.id,
      ['dep-agent-a', 'dep-agent-b'],
      [
        { description: 'Write the first file', declaredFileScope: ['src/first.txt'] },
        {
          description: 'Write the second file',
          declaredFileScope: ['src/second.txt'],
          dependencies: ['dep-agent-a'],
        },
      ],
    );
    const [first, second] = session.terminals;

    expect(first!.task?.state).toBe('running');
    expect(second!.task?.state).toBe('blocked');
    expect(second!.task?.blockedReason).toContain('Waiting for dependency tasks');
    expect(second!.status).toBe('stopped');
    expect(second!.errorCode).toBe('awaiting_dependencies');
    expect(fs.existsSync(profileEvidence('dep-agent-b'))).toBe(false);

    await waitForAgentExit(session.id, first!.id);
    await stopSession(session.id);
    commitFile(first!.workspace!.workingDirectory, 'src/first.txt', 'first\n');
    const completed = await authorized('post', `/api/orchestration/tasks/${first!.id}/complete`).send({
      summary: 'Added src/first.txt and committed it.',
    });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.task.state).toBe('awaiting_integration');

    const integrated = await authorized('post', `/api/orchestration/tasks/${first!.id}/integrate`).send({
      acknowledgeNoValidation: true,
    });
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);
    expect(integrated.body.task.state).toBe('integrated');
    expect(targetTreeFile(project.path, 'src/first.txt')).toBe('first\n');

    // Integration releases the dependency and reschedules automatically.
    await waitUntil(
      () => fs.existsSync(profileEvidence('dep-agent-b')),
      'The dependent agent CLI was never started after its dependency integrated',
    );
    const evidence = JSON.parse(fs.readFileSync(profileEvidence('dep-agent-b'), 'utf8')) as {
      cwd: string;
    };
    expect(evidence.cwd).toBe(second!.workspace!.workingDirectory);
    expect((await getTask(second!.id)).state).toBe('running');
  }, 40_000);

  it('does not treat failed, cancelled, or unknown dependencies as satisfied', async () => {
    addProfile('dep-state-a');
    addProfile('dep-state-b');
    const project = await makeProject('Dependency States');
    const session = await createSession(
      project.id,
      ['dep-state-a', 'dep-state-b'],
      [
        { description: 'Blocked on failed work' },
        { description: 'Blocked on cancelled work' },
      ],
    );
    const [first, second] = session.terminals;

    const failed = await authorized(
      'patch',
      `/api/sessions/${session.id}/terminals/${first!.id}/task`,
    ).send({ status: 'failed' });
    expect(failed.status).toBe(200);
    expect(
      failed.body.session.terminals.find((terminal: { id: string }) => terminal.id === first!.id)
        .task.state,
    ).toBe('failed');

    const cancelled = await authorized(
      'patch',
      `/api/sessions/${session.id}/terminals/${second!.id}/task`,
    ).send({ status: 'cancelled' });
    expect(cancelled.status).toBe(200);

    db.prepare(
      `UPDATE agent_tasks SET dependencies_json = ?, state = 'blocked'
       WHERE id = ?`,
    ).run(JSON.stringify([first!.id, second!.id, 'does-not-exist']), second!.id);

    const blocked = await getTask(second!.id);
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toContain('Unknown dependency');

    const result = await orchestration.scheduleSession(session.id);
    expect(result.scheduled).toEqual([]);
    expect(fs.existsSync(profileEvidence('dep-state-b'))).toBe(false);
  }, 30_000);

  it('rejects cyclic and unknown dependency references', async () => {
    addProfile('cycle-agent-a');
    addProfile('cycle-agent-b');
    const project = await makeProject('Cycle Project');
    const session = await createSession(project.id, ['cycle-agent-a', 'cycle-agent-b'], [
      { description: 'First task' },
      { description: 'Second task', dependencies: ['cycle-agent-a'] },
    ]);
    const [first, second] = session.terminals;
    await stopSession(session.id);

    const cycle = await authorized(
      'patch',
      `/api/sessions/${session.id}/terminals/${first!.id}/task`,
    ).send({ dependencies: [second!.id] });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('task_dependency_cycle');

    const unknown = await authorized(
      'patch',
      `/api/sessions/${session.id}/terminals/${first!.id}/task`,
    ).send({ dependencies: ['missing-terminal'] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('invalid_task_dependency');
  }, 20_000);

  it('does not schedule the same task twice under simultaneous requests', async () => {
    addProfile('dup-agent', 5_000);
    const project = await makeProject('Duplicate Scheduling');
    const session = await createSession(project.id, ['dup-agent'], [
      { description: 'Only one run', declaredFileScope: ['src'] },
    ]);
    const taskId = session.terminals[0]!.id;
    await waitForAgentExit(session.id, taskId);
    await stopSession(session.id);
    orchestration.retryTask(taskId);

    const [first, second] = await Promise.all([
      authorized('post', `/api/orchestration/sessions/${session.id}/schedule`),
      authorized('post', `/api/orchestration/sessions/${session.id}/schedule`),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const scheduled = [
      ...(first.body.result.scheduled as string[]),
      ...(second.body.result.scheduled as string[]),
    ];
    expect(scheduled.filter((id) => id === taskId)).toHaveLength(1);
    expect(readLogLines('dup-agent')).toHaveLength(1);
    expect((await getTask(taskId)).state).toBe('running');
  }, 30_000);

  it('enforces the backend concurrency limit across projects', async () => {
    const singleSlot = new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: 1,
      maxLiveTerminals: 8,
    });
    addProfile('limit-agent-a', 5_000);
    addProfile('limit-agent-b', 5_000);
    const projectA = await makeProject('Limit Project A');
    const projectB = await makeProject('Limit Project B');
    const sessionA = await createSession(projectA.id, ['limit-agent-a'], [
      { description: 'Work A' },
    ]);
    const sessionB = await createSession(projectB.id, ['limit-agent-b'], [
      { description: 'Work B' },
    ]);
    await waitForAgentExit(sessionA.id, sessionA.terminals[0]!.id);
    await waitForAgentExit(sessionB.id, sessionB.terminals[0]!.id);
    await stopSession(sessionA.id);
    await stopSession(sessionB.id);
    singleSlot.retryTask(sessionA.terminals[0]!.id);
    singleSlot.retryTask(sessionB.terminals[0]!.id);

    const result = await singleSlot.scheduleAll();
    expect(result.scheduled).toHaveLength(1);
    expect(result.skipped.some((entry) => entry.reason.includes('concurrency limit'))).toBe(true);
    expect(singleSlot.capacity(projectA.id).maxConcurrentAgents).toBe(1);

    await singleSlot.scheduleAll();
    // Still one active agent at a time; the second only starts once the first is no longer active.
    const active = db
      .prepare(`SELECT COUNT(*) AS count FROM agent_tasks WHERE state IN ('assigned','running','validating')`)
      .get() as { count: number };
    expect(Number(active.count)).toBeLessThanOrEqual(1);
  }, 40_000);
});

describe('completion evidence', () => {
  it('refuses completion without a commit and without stopping the CLI', async () => {
    addProfile('completion-agent', 5_000);
    const project = await makeProject('Completion Project');
    const session = await createSession(project.id, ['completion-agent'], [
      { description: 'Do the work', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;

    const whileRunning = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Nothing yet' });
    expect(whileRunning.status).toBe(409);
    expect(whileRunning.body.error.code).toBe('task_cli_running');

    await waitForAgentExit(session.id, terminal.id);
    const noCommit = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Claimed without a commit' });
    expect(noCommit.status).toBe(409);
    expect(noCommit.body.error.code).toBe('completion_requires_commit');
    expect((await getTask(terminal.id)).state).toBe('running');
  }, 25_000);

  it('preserves untracked work instead of completing with a dirty worktree', async () => {
    addProfile('dirty-agent');
    const project = await makeProject('Dirty Worktree Project');
    const session = await createSession(project.id, ['dirty-agent'], [
      { description: 'Leave work uncommitted', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    commitFile(terminal.workspace!.workingDirectory, 'src/committed.txt', 'committed\n');

    const untracked = path.join(terminal.workspace!.workingDirectory, 'src', 'untracked.txt');
    fs.writeFileSync(untracked, 'keep me\n');
    const rejected = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Maybe done' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('completion_requires_clean_worktree');
    expect(rejected.body.error.message).toContain('src/untracked.txt');
    expect(fs.readFileSync(untracked, 'utf8')).toBe('keep me\n');
  }, 25_000);

  it('records completion and waits for manual integration by default', async () => {
    addProfile('evidence-agent');
    const project = await makeProject('Evidence Project');
    const session = await createSession(project.id, ['evidence-agent'], [
      { description: 'Add a file', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    commitFile(terminal.workspace!.workingDirectory, 'src/added.txt', 'added\n');

    const completed = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Added src/added.txt' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    const task = completed.body.task as AgentTaskSummary;
    expect(task.state).toBe('awaiting_integration');
    expect(task.validationStatus).toBe('not_configured');
    expect(task.changedFiles).toEqual(['src/added.txt']);
    expect(task.completedAt).toBeTruthy();
    expect(completed.body.logs.integrations).toEqual([]);

    const settings = await authorized(
      'get',
      `/api/orchestration/settings?projectId=${project.id}`,
    );
    expect(settings.body.settings.autoIntegrate).toBe(false);
  }, 25_000);
});

describe('validation pipeline', () => {
  async function completedTaskWithCommit(profile: string, name: string) {
    addProfile(profile);
    const project = await makeProject(name);
    const session = await createSession(project.id, [profile], [
      { description: 'Change a file', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    commitFile(terminal.workspace!.workingDirectory, 'src/change.txt', 'change\n');
    return { project, session, terminal };
  }

  it('runs configured checks and blocks a failing check', async () => {
    const { project, terminal } = await completedTaskWithCommit(
      'validation-agent',
      'Validation Project',
    );
    const marker = path.join(tempDir, 'validation-cwd.txt');
    await configure(project.id, {
      validationCommands: [
        {
          name: 'unit tests',
          command: 'node',
          args: [validationScript, 'pass', marker],
          required: true,
          timeoutMs: 10_000,
        },
      ],
    });

    const passed = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Changed one file' });
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(passed.body.task.state).toBe('awaiting_integration');
    expect(passed.body.task.validationStatus).toBe('passed');
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(terminal.workspace!.workingDirectory);

    await configure(project.id, {
      validationCommands: [
        {
          name: 'lint',
          command: 'node',
          args: [validationScript, 'fail'],
          required: true,
          timeoutMs: 10_000,
        },
      ],
    });
    const failed = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/validate`,
    );
    expect(failed.status, JSON.stringify(failed.body)).toBe(200);
    expect(failed.body.task.state).toBe('failed');
    expect(failed.body.task.validationStatus).toBe('failed');
    expect(failed.body.task.validationSummary).toContain('lint');
    const logs = await getLogs(terminal.id);
    expect(logs.validations.at(-1)?.exitCode).toBe(2);
    expect(logs.validations.at(-1)?.output).toContain('assertion failed');

    const integration = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({});
    expect(integration.status).toBe(409);
    expect(integration.body.error.code).toBe('validation_failed');
  }, 30_000);

  it('times out slow checks and never reports them as passed', async () => {
    const { project, terminal } = await completedTaskWithCommit(
      'timeout-agent',
      'Timeout Project',
    );
    await configure(project.id, {
      validationCommands: [
        {
          name: 'slow check',
          command: 'node',
          args: [validationScript, 'slow'],
          required: true,
          timeoutMs: 1_000,
        },
      ],
    });

    const response = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Slow validation' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.task.validationStatus).toBe('failed');
    expect(response.body.task.validationSummary).toContain('timed out');
    const logs = await getLogs(terminal.id);
    expect(logs.validations.at(-1)?.status).toBe('timed_out');
  }, 30_000);

  it('supports cancelling a running validation without treating it as a pass', async () => {
    const { project, terminal } = await completedTaskWithCommit(
      'cancel-agent',
      'Cancel Project',
    );
    await configure(project.id, {
      validationCommands: [
        {
          name: 'slow check',
          command: 'node',
          args: [validationScript, 'slow'],
          required: true,
          timeoutMs: 60_000,
        },
      ],
    });

    const running = authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    )
      .send({ summary: 'Validate then cancel' })
      .then((response) => response);
    await waitUntil(
      async () => (await getTask(terminal.id)).state === 'validating',
      'Validation did not start',
    );
    const cancel = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/cancel-validation`,
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);

    const settled = await running;
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.task.validationStatus).toBe('failed');
    expect(settled.body.task.state).toBe('failed');
    expect(settled.body.task.validationSummary).toContain('cancelled');
    const logs = await getLogs(terminal.id);
    expect(logs.validations.some((entry) => entry.status === 'cancelled')).toBe(true);
  }, 30_000);
});

describe('integration queue', () => {
  async function integratedFixture(
    profile: string,
    projectName: string,
    declaredScope: string[] = ['src'],
  ) {
    addProfile(profile);
    const project = await makeProject(projectName);
    const session = await createSession(project.id, [profile], [
      { description: 'Implement the change', declaredFileScope: declaredScope },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    return { project, session, terminal };
  }

  it('integrates through Git into the dedicated integration branch and records the result', async () => {
    const { project, terminal } = await integratedFixture(
      'integrate-agent',
      'Integration Project',
    );
    const worktree = terminal.workspace!.workingDirectory;
    commitFile(worktree, 'src/feature.txt', 'feature\n');
    const mainBefore = git(project.path, ['rev-parse', 'main']);

    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Added the feature file',
    });
    const response = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const task = response.body.task as AgentTaskSummary;
    expect(task.state).toBe('integrated');
    expect(task.integrationStatus).toBe('integrated');
    expect(task.integrationCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(task.targetBranch).toBe(DEFAULT_INTEGRATION_BRANCH);
    expect(task.declaredFileScope).toEqual(['src']);

    expect(targetTreeFile(project.path, 'src/feature.txt')).toBe('feature\n');
    expect(git(project.path, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(gitResult(project.path, ['status', '--porcelain']).stdout.trim()).toBe('');

    const logs = await getLogs(terminal.id);
    expect(logs.integrations).toHaveLength(1);
    expect(logs.integrations[0]!.state).toBe('integrated');
    // After successful integration, the worktree and branch are cleaned up.
    expect(fs.existsSync(terminal.workspace!.path)).toBe(false);
    expect(
      gitResult(project.path, ['rev-parse', '--verify', `refs/heads/${terminal.workspace!.branchName}`])
        .status,
    ).not.toBe(0);
  }, 30_000);

  it('rejects protected-path changes and keeps the source branch', async () => {
    const { project, terminal } = await integratedFixture(
      'protected-agent',
      'Protected Path Project',
    );
    await configure(project.id, { protectedPaths: ['protected.txt'] });
    commitFile(terminal.workspace!.workingDirectory, 'protected.txt', 'tampered\n');

    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Touched a protected file',
    });
    const response = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('protected_path_violation');
    const task = await getTask(terminal.id);
    expect(task.state).not.toBe('integrated');
    expect(task.integrationStatus).toBe('failed');
    expect(task.integrationReason).toContain('Protected paths');
    expect(targetTreeFile(project.path, 'protected.txt')).toBe('protected\n');
    const logs = await getLogs(terminal.id);
    expect(logs.integrations.at(-1)?.state).toBe('rejected');
  }, 30_000);

  it('flags out-of-scope changes and requires explicit approval', async () => {
    const { terminal } = await integratedFixture('scope-agent', 'Scope Project');
    commitFile(terminal.workspace!.workingDirectory, 'outside/other.txt', 'outside\n');

    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Changed something outside the scope',
    });
    expect((await getTask(terminal.id)).scopeViolations).toEqual(['outside/other.txt']);

    const rejected = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('scope_violation');
    expect(rejected.body.error.message).toContain('outside/other.txt');

    const approved = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true, allowOutOfScope: true });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.task.state).toBe('integrated');
  }, 35_000);

  it('detects Git conflicts, records the reason, and preserves the source work', async () => {
    const { project, terminal } = await integratedFixture(
      'conflict-agent',
      'Conflict Project',
    );
    const worktree = terminal.workspace!.workingDirectory;
    commitFile(worktree, 'src/a.txt', 'agent version\n');
    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Changed src/a.txt',
    });

    // First integration creates the integration branch.
    const first = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // A second, independent task changes the same file from the same base.
    addProfile('conflict-agent-b');
    const second = await createSession(project.id, ['conflict-agent-b'], [
      { description: 'Also change src/a.txt', declaredFileScope: ['src'] },
    ]);
    const other = second.terminals[0]!;
    await waitForAgentExit(second.id, other.id);
    commitFile(other.workspace!.workingDirectory, 'src/a.txt', 'second agent version\n');
    await authorized('post', `/api/orchestration/tasks/${other.id}/complete`).send({
      summary: 'Conflicting change',
    });
    const rejected = await authorized(
      'post',
      `/api/orchestration/tasks/${other.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(rejected.status).toBe(409);
    expect(['git_conflict', 'overlapping_changes']).toContain(rejected.body.error.code);
    const task = await getTask(other.id);
    expect(task.state).not.toBe('integrated');
    expect(task.integrationReason).toBeTruthy();
    expect(
      gitResult(project.path, ['rev-parse', '--verify', `refs/heads/${other.workspace!.branchName}`])
        .status,
    ).toBe(0);
    expect(
      fs.readFileSync(path.join(other.workspace!.workingDirectory, 'src', 'a.txt'), 'utf8'),
    ).toBe('second agent version\n');
    expect(targetTreeFile(project.path, 'src/a.txt')).toBe('agent version\n');
  }, 40_000);

  it('rejects a stale candidate whose branch changed after it was queued', async () => {
    const { terminal } = await integratedFixture('stale-agent', 'Stale Project');
    const worktree = terminal.workspace!.workingDirectory;
    commitFile(worktree, 'src/stale.txt', 'one\n');
    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'First commit',
    });

    await orchestration.enqueueIntegration(terminal.id, { acknowledgeNoValidation: true });
    commitFile(worktree, 'src/stale.txt', 'two\n', 'second commit');
    await orchestration.processQueue();

    const task = await getTask(terminal.id);
    expect(task.state).toBe('awaiting_integration');
    expect(task.integrationReason).toContain('changed after it was queued');
    const logs = await getLogs(terminal.id);
    expect(logs.integrations.at(-1)?.state).toBe('rejected');
  }, 30_000);

  it('serializes simultaneous integration requests without overwriting the target', async () => {
    addProfile('parallel-agent-a');
    addProfile('parallel-agent-b');
    const project = await makeProject('Parallel Integration');
    const session = await createSession(project.id, ['parallel-agent-a', 'parallel-agent-b'], [
      { description: 'Add file one', declaredFileScope: ['src/one.txt'] },
      { description: 'Add file two', declaredFileScope: ['src/two.txt'] },
    ]);
    const [first, second] = session.terminals;
    await waitForAgentExit(session.id, first!.id);
    await waitForAgentExit(session.id, second!.id);
    commitFile(first!.workspace!.workingDirectory, 'src/one.txt', 'one\n');
    commitFile(second!.workspace!.workingDirectory, 'src/two.txt', 'two\n');
    for (const terminal of [first!, second!]) {
      await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
        summary: 'Committed file',
      });
    }

    const [a, b] = await Promise.all([
      authorized('post', `/api/orchestration/tasks/${first!.id}/integrate`).send({
        acknowledgeNoValidation: true,
      }),
      authorized('post', `/api/orchestration/tasks/${second!.id}/integrate`).send({
        acknowledgeNoValidation: true,
      }),
    ]);
    expect(
      [a.status, b.status],
      `responses: ${JSON.stringify(a.body)} ${JSON.stringify(b.body)}`,
    ).toEqual([200, 200]);
    expect(a.body.task.state).toBe('integrated');
    expect(b.body.task.state).toBe('integrated');
    expect(targetTreeFile(project.path, 'src/one.txt')).toBe('one\n');
    expect(targetTreeFile(project.path, 'src/two.txt')).toBe('two\n');
    // Both merge commits are recorded on the target; neither was overwritten.
    for (const mergeCommit of [
      a.body.task.integrationCommit as string,
      b.body.task.integrationCommit as string,
    ]) {
      expect(
        gitResult(project.path, [
          'merge-base',
          '--is-ancestor',
          mergeCommit,
          DEFAULT_INTEGRATION_BRANCH,
        ]).status,
      ).toBe(0);
    }
    expect(
      git(project.path, ['rev-list', '--parents', '-n', '1', DEFAULT_INTEGRATION_BRANCH])
        .trim()
        .split(/\s+/),
    ).toHaveLength(3);
  }, 45_000);

  it('refuses to integrate into a branch checked out in a worktree', async () => {
    const { project, terminal } = await integratedFixture(
      'checked-out-agent',
      'Checked Out Project',
    );
    await configure(project.id, { targetBranch: 'main' });
    commitFile(terminal.workspace!.workingDirectory, 'src/check.txt', 'x\n');
    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Ready but unsafe target',
    });
    const mainBefore = git(project.path, ['rev-parse', 'main']);
    const response = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('target_branch_checked_out');
    expect(git(project.path, ['rev-parse', 'main'])).toBe(mainBefore);
  }, 30_000);
});

describe('shared folder safety and isolation', () => {
  it('rejects multi-agent task execution in a shared folder', async () => {
    addProfile('shared-agent-a');
    addProfile('shared-agent-b');
    const project = await makeProject('Shared Safety');
    const rejected = await authorized('post', '/api/sessions').send({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'shared',
      toolIds: ['shared-agent-a', 'shared-agent-b'],
      tasks: [
        { toolId: 'shared-agent-a', description: 'Edit the frontend' },
        { toolId: 'shared-agent-b', description: 'Edit the backend' },
      ],
    });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('shared_folder_concurrent_agents');
    expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
    expect(manager.liveCount).toBe(0);

    // A single shared-folder agent is still supported.
    const single = await createSession(
      project.id,
      ['shared-agent-a'],
      [{ description: 'Edit alone' }],
      'shared',
    );
    expect(single.workspaceMode).toBe('shared');
    expect(single.terminals[0]!.workspace).toBeNull();

    const second = await authorized('post', `/api/sessions/${single.id}/terminals`).send({
      toolId: 'shared-agent-b',
      task: { description: 'Compete for the same files' },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('shared_folder_concurrent_agents');
  }, 30_000);

  it('converts a stopped clean shared session into isolated worktrees without moving files', async () => {
    addProfile('convert-agent-a');
    addProfile('convert-agent-b');
    const project = await makeProject('Convert Project');
    const session = await createSession(
      project.id,
      ['convert-agent-a', 'convert-agent-b'],
      [],
      'shared',
    );
    expect(session.workspaceMode).toBe('shared');
    await stopSession(session.id);
    const sharedFile = path.join(project.path, 'src', 'a.txt');

    const converted = await authorized(
      'post',
      `/api/orchestration/sessions/${session.id}/isolate`,
    );
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.session.workspaceMode).toBe('isolated');
    const terminals = converted.body.session.terminals as SessionBody['session']['terminals'];
    expect(terminals.every((terminal) => terminal.workspace !== null)).toBe(true);
    expect(new Set(terminals.map((terminal) => terminal.workspace!.path)).size).toBe(2);
    // The shared folder itself was not touched.
    expect(fs.readFileSync(sharedFile, 'utf8')).toBe('a\n');
    expect(gitResult(project.path, ['status', '--porcelain']).stdout.trim()).toBe('');
    expect(
      db.prepare('SELECT workspace_mode FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ workspace_mode: 'isolated' });
  }, 30_000);

  it('rejects conversion of a dirty or unsupported repository', async () => {
    addProfile('dirty-convert-a');
    addProfile('dirty-convert-b');
    const project = await makeProject('Dirty Convert');
    const session = await createSession(
      project.id,
      ['dirty-convert-a', 'dirty-convert-b'],
      [],
      'shared',
    );
    await stopSession(session.id);
    fs.writeFileSync(path.join(project.path, 'src', 'dirty.txt'), 'uncommitted\n');

    const response = await authorized(
      'post',
      `/api/orchestration/sessions/${session.id}/isolate`,
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('project_git_dirty');
    expect(fs.readFileSync(path.join(project.path, 'src', 'dirty.txt'), 'utf8')).toBe(
      'uncommitted\n',
    );
    expect(
      db.prepare('SELECT workspace_mode FROM sessions WHERE id = ?').get(session.id),
    ).toEqual({ workspace_mode: 'shared' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_workspaces').get()).toEqual({
      count: 0,
    });
  }, 30_000);
});

describe('recovery, configuration, and security', () => {
  it('recovers interrupted tasks, validations, and integrations after a restart', async () => {
    addProfile('recover-agent');
    const project = await makeProject('Recovery Project');
    const session = await createSession(project.id, ['recover-agent'], [
      { description: 'Interrupted work' },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);

    db.prepare(`UPDATE agent_tasks SET state = 'running' WHERE id = ?`).run(terminal.id);
    db.prepare(
      `INSERT INTO task_validations (
         id, task_id, attempt, name, command, args_json, status, exit_code,
         duration_ms, output, started_at, finished_at
       ) VALUES ('validation-running', ?, 1, 'tests', 'node', '[]', 'running', NULL, NULL, '', ?, NULL)`,
    ).run(terminal.id, new Date().toISOString());
    db.prepare(
      `INSERT INTO task_integrations (
         id, task_id, state, target_branch, source_branch, source_commit,
         target_commit_before, merge_commit, changed_files_json, violations_json,
         reason, attempt, created_at, updated_at
       ) VALUES ('integration-running', ?, 'running', ?, 'branch', NULL, NULL, NULL, '[]', '[]', NULL, 1, ?, ?)`,
    ).run(terminal.id, DEFAULT_INTEGRATION_BRANCH, new Date().toISOString(), new Date().toISOString());

    const changes = orchestration.recover();
    expect(changes).toBeGreaterThan(0);
    expect((await getTask(terminal.id)).state).toBe('ready');
    expect(
      db.prepare('SELECT status FROM task_validations WHERE id = ?').get('validation-running'),
    ).toEqual({ status: 'failed' });
    const integration = db
      .prepare('SELECT state, reason FROM task_integrations WHERE id = ?')
      .get('integration-running') as { state: string; reason: string };
    expect(integration.state).toBe('failed');
    expect(integration.reason).toContain('preserved');
  }, 25_000);

  it('validates settings, branch targets, and requires the local token', async () => {
    const project = await makeProject('Settings Project');
    const anonymous = await request(app).get(`/api/orchestration/sessions/anything`);
    expect(anonymous.status).toBe(401);

    const unsafeCommand = await authorized('put', '/api/orchestration/settings').send({
      projectId: project.id,
      validationCommands: [
        { name: 'bad', command: 'node', args: ['x && calc.exe'], required: true },
      ],
    });
    expect(unsafeCommand.status).toBe(400);
    expect(unsafeCommand.body.error.code).toBe('invalid_validation_command');

    const badBranch = await authorized('put', '/api/orchestration/settings').send({
      projectId: project.id,
      targetBranch: 'bad..name',
    });
    expect(badBranch.status).toBe(400);
    expect(badBranch.body.error.code).toBe('invalid_branch_name');

    const tooMany = await authorized('put', '/api/orchestration/settings').send({
      projectId: project.id,
      maxConcurrentAgents: 999,
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('concurrency_limit_invalid');

    const configured = await authorized('put', '/api/orchestration/settings').send({
      projectId: project.id,
      autoIntegrate: false,
      maxConcurrentAgents: 1,
      targetBranch: 'release/integration',
      protectedPaths: ['harness.config.json'],
      validationCommands: [
        {
          name: 'typecheck',
          command: 'node',
          args: [validationScript, 'pass'],
          required: true,
          timeoutMs: 30_000,
        },
      ],
    });
    expect(configured.status).toBe(200);
    expect(configured.body.settings).toMatchObject({
      autoIntegrate: false,
      maxConcurrentAgents: 1,
      resolvedTargetBranch: 'release/integration',
      protectedPaths: ['harness.config.json'],
    });
  }, 20_000);

  it('auto-integrates only when the project explicitly opts in', async () => {
    addProfile('auto-agent');
    const project = await makeProject('Auto Integration');
    await configure(project.id, {
      autoIntegrate: true,
      validationCommands: [
        {
          name: 'quick check',
          command: 'node',
          args: [validationScript, 'pass'],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    const session = await createSession(project.id, ['auto-agent'], [
      { description: 'Auto integrate this', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    commitFile(terminal.workspace!.workingDirectory, 'src/auto.txt', 'auto\n');

    const response = await authorized(
      'post',
      `/api/orchestration/tasks/${terminal.id}/complete`,
    ).send({ summary: 'Auto integration candidate' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.task.state).toBe('integrated');
    expect(response.body.task.validationStatus).toBe('passed');
    expect(targetTreeFile(project.path, 'src/auto.txt')).toBe('auto\n');
  }, 40_000);
});

const FEATURE_SOURCE = 'module.exports = { greet: (name) => `hello ${name}` };\n';
const CONSUMER_SOURCE =
  "const { greet } = require('./feature.cjs');\nmodule.exports = (name) => greet(name).toUpperCase();\n";

describe('dependency base inheritance and combined-candidate validation', () => {
  async function dependentFixture(
    prefix: string,
    projectName: string,
    options: { pauseScheduling?: boolean } = {},
  ) {
    addProfile(`${prefix}-a`);
    addProfile(`${prefix}-b`);
    const project = await makeProject(projectName);
    const session = await createSession(project.id, [`${prefix}-a`, `${prefix}-b`], [
      { description: 'Add the feature function', declaredFileScope: ['src/feature.cjs'] },
      {
        description: 'Add the consumer',
        declaredFileScope: ['src/consumer.cjs'],
        dependencies: [`${prefix}-a`],
      },
    ]);
    const [first, second] = session.terminals;
    await waitForAgentExit(session.id, first!.id);
    await stopSession(session.id);
    commitFile(first!.workspace!.workingDirectory, 'src/feature.cjs', FEATURE_SOURCE);
    const completed = await authorized(
      'post',
      `/api/orchestration/tasks/${first!.id}/complete`,
    ).send({ summary: 'Added the feature function.' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    if (options.pauseScheduling) {
      await configure(project.id, { schedulingPaused: true });
    }
    const integrated = await authorized(
      'post',
      `/api/orchestration/tasks/${first!.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);
    return {
      project,
      session,
      first: first!,
      second: second!,
      integrationCommit: integrated.body.task.integrationCommit as string,
    };
  }

  async function startDependent(
    session: SessionBody['session'],
    second: SessionBody['session']['terminals'][number],
  ): Promise<void> {
    // A successful integration reschedules the session automatically; fall back
    // to an explicit schedule request only when capacity or pause state delayed it.
    await waitUntil(
      () => fs.existsSync(profileEvidence(second.toolProfileId)),
      'The dependent agent CLI was never started',
      20_000,
    ).catch(async () => {
      const scheduled = await authorized('post', `/api/orchestration/sessions/${session.id}/schedule`);
      expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
      expect(scheduled.body.result.scheduled).toContain(second.id);
      await waitUntil(
        () => fs.existsSync(profileEvidence(second.toolProfileId)),
        'The dependent agent CLI was never started',
      );
    });
  }

  function commitConsumer(worktree: string): void {
    commitFile(worktree, 'src/consumer.cjs', CONSUMER_SOURCE, 'add consumer');
  }

  function workspaceRecord(terminalId: string): { base_commit: string } {
    return db
      .prepare('SELECT base_commit FROM agent_workspaces WHERE terminal_id = ?')
      .get(terminalId) as { base_commit: string };
  }

  it('starts a dependent worktree from the integrated commit so it can import the function', async () => {
    const { project, session, second, integrationCommit } = await dependentFixture(
      'inherit',
      'Inheritance Project',
    );
    await startDependent(session, second);

    const worktree = second.workspace!.workingDirectory;
    const branch = second.workspace!.branchName;
    expect(
      fs.readFileSync(path.join(worktree, 'src', 'feature.cjs'), 'utf8').replace(/\r\n/g, '\n'),
    ).toBe(FEATURE_SOURCE);
    expect(git(project.path, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(integrationCommit);
    expect(workspaceRecord(second.id).base_commit).toBe(integrationCommit);

    const call = spawnSync(
      process.execPath,
      [
        '-e',
        "const m = require('./src/feature.cjs'); if (m.greet('b') !== 'hello b') process.exit(7);",
      ],
      { cwd: worktree, encoding: 'utf8', windowsHide: true },
    );
    expect(call.status, call.stderr).toBe(0);

    await waitForAgentExit(session.id, second.id);
    commitConsumer(worktree);
    const completed = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/complete`,
    ).send({ summary: 'Added the consumer.' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.task.changedFiles).toEqual(['src/consumer.cjs']);
    const integrated = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/integrate`,
    ).send({ acknowledgeNoValidation: true });
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);
    expect(integrated.body.logs.integrations.at(-1)!.targetCommitBefore).toBe(integrationCommit);
    expect(targetTreeFile(project.path, 'src/consumer.cjs')).toBe(CONSUMER_SOURCE);
  }, 45_000);

  it('validates the combined candidate in isolation before updating the target', async () => {
    const { project, session, second, integrationCommit } = await dependentFixture(
      'combined',
      'Combined Candidate Project',
    );
    const marker = path.join(tempDir, 'combined-validation-cwd.txt');
    await configure(project.id, {
      validationCommands: [
        {
          name: 'combined checks',
          command: 'node',
          args: [
            validationScript,
            'combined',
            marker,
            project.path,
            DEFAULT_INTEGRATION_BRANCH,
            'src/feature.cjs',
            'src/consumer.cjs',
          ],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    await startDependent(session, second);
    await waitForAgentExit(session.id, second.id);
    commitConsumer(second.workspace!.workingDirectory);

    const completed = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/complete`,
    ).send({ summary: 'Added the consumer.' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.task.validationStatus).toBe('passed');
    // The task's own validation still ran before the integration target moved.
    expect(git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim()).toBe(
      integrationCommit,
    );

    const mainBefore = git(project.path, ['rev-parse', 'main']);
    const integrated = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/integrate`,
    ).send({});
    expect(integrated.status, JSON.stringify(integrated.body)).toBe(200);
    const task = integrated.body.task as AgentTaskSummary;
    expect(task.state).toBe('integrated');

    const directories = fs
      .readFileSync(marker, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(directories).toHaveLength(2);
    expect(directories[0]).toBe(second.workspace!.workingDirectory);
    expect(directories[1]).not.toBe(project.path);
    expect(directories[1]).not.toBe(second.workspace!.workingDirectory);
    expect(
      directories[1]!.startsWith(path.join(config.runtimeDir, 'validation-worktrees')),
    ).toBe(true);
    // The isolated validation worktree was removed after the run.
    expect(fs.existsSync(directories[1]!)).toBe(false);

    const logs = await getLogs(second.id);
    const attempt = logs.integrations.at(-1)!;
    expect(attempt.state).toBe('integrated');
    expect(attempt.targetCommitBefore).toBe(integrationCommit);
    expect(attempt.candidateCommit).toBe(task.integrationCommit);
    expect(attempt.validationSummary).toContain('combined candidate');
    const combinedChecks = logs.validations.filter((entry) => entry.phase === 'integration');
    expect(combinedChecks).toHaveLength(1);
    expect(combinedChecks[0]!.status).toBe('passed');

    // Validation never touched the project working directory or the main branch.
    expect(gitResult(project.path, ['status', '--porcelain']).stdout.trim()).toBe('');
    expect(git(project.path, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(targetTreeFile(project.path, 'src/consumer.cjs')).toBe(CONSUMER_SOURCE);
  }, 45_000);

  it('leaves the target unchanged when combined validation fails, then retries safely', async () => {
    const { project, session, second, integrationCommit } = await dependentFixture(
      'candidate-fail',
      'Candidate Failure Project',
    );
    const marker = path.join(tempDir, 'candidate-failure-cwd.txt');
    await configure(project.id, {
      validationCommands: [
        {
          name: 'combined checks',
          command: 'node',
          args: [
            validationScript,
            'merge-only-fail',
            marker,
            project.path,
            DEFAULT_INTEGRATION_BRANCH,
            'src/consumer.cjs',
          ],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    await startDependent(session, second);
    await waitForAgentExit(session.id, second.id);
    const worktree = second.workspace!.workingDirectory;
    const branch = second.workspace!.branchName;
    commitConsumer(worktree);
    const completed = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/complete`,
    ).send({ summary: 'Added the consumer.' });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.task.validationStatus).toBe('passed');

    const rejected = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/integrate`,
    ).send({});
    // The failed attempt is recorded on the task instead of moving the ref.
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.task.integrationStatus).toBe('failed');
    expect(rejected.body.task.integrationReason).toContain('Combined-candidate');

    // The target ref, the source branch and its worktree are all preserved.
    expect(git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim()).toBe(
      integrationCommit,
    );
    expect(
      gitResult(project.path, ['show', `${DEFAULT_INTEGRATION_BRANCH}:src/consumer.cjs`]).status,
    ).not.toBe(0);
    const failedTask = await getTask(second.id);
    expect(failedTask.state).toBe('awaiting_integration');
    expect(failedTask.integrationStatus).toBe('failed');
    expect(failedTask.integrationCommit).toBeNull();
    expect(fs.readFileSync(path.join(worktree, 'src', 'consumer.cjs'), 'utf8')).toBe(
      CONSUMER_SOURCE,
    );
    expect(gitResult(project.path, ['rev-parse', '--verify', `refs/heads/${branch}`]).status).toBe(0);

    const failedLogs = await getLogs(second.id);
    const rejectedAttempt = failedLogs.integrations.at(-1)!;
    expect(rejectedAttempt.state).toBe('rejected');
    expect(rejectedAttempt.mergeCommit).toBeNull();
    expect(rejectedAttempt.candidateCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      gitResult(project.path, ['cat-file', '-e', `${rejectedAttempt.candidateCommit}^{commit}`])
        .status,
    ).toBe(0);
    expect(rejectedAttempt.reason).toContain('Combined-candidate');
    const integrationChecks = failedLogs.validations.filter(
      (entry) => entry.phase === 'integration',
    );
    expect(integrationChecks.at(-1)!.status).toBe('failed');
    const directories = fs
      .readFileSync(marker, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);
    expect(fs.existsSync(directories.at(-1)!)).toBe(false);

    await configure(project.id, {
      validationCommands: [
        {
          name: 'combined checks',
          command: 'node',
          args: [validationScript, 'pass'],
          required: true,
          timeoutMs: 20_000,
        },
      ],
    });
    const retried = await authorized(
      'post',
      `/api/orchestration/tasks/${second.id}/integrate`,
    ).send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const attempts = retried.body.logs.integrations as Array<{ state: string; attempt: number }>;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.state).toBe('rejected');
    expect(attempts[0]!.attempt).toBe(1);
    expect(attempts[1]!.state).toBe('integrated');
    expect(attempts[1]!.attempt).toBe(2);
    expect(targetTreeFile(project.path, 'src/consumer.cjs')).toBe(CONSUMER_SOURCE);
  }, 60_000);

  it('rejects a stale or concurrently advanced integration target without rewriting it', async () => {
    const { project, session, second } = await dependentFixture(
      'stale-target',
      'Stale Target Project',
    );
    await startDependent(session, second);
    await waitForAgentExit(session.id, second.id);
    const worktree = second.workspace!.workingDirectory;
    const branch = second.workspace!.branchName;
    commitConsumer(worktree);
    await authorized('post', `/api/orchestration/tasks/${second.id}/complete`).send({
      summary: 'Added the consumer.',
    });

    await orchestration.enqueueIntegration(second.id, { acknowledgeNoValidation: true });

    // Another integrator advances the target to a conflicting commit meanwhile.
    const advancePath = path.join(tempDir, 'target-advance');
    git(project.path, ['worktree', 'add', '--detach', advancePath, DEFAULT_INTEGRATION_BRANCH]);
    commitFile(advancePath, 'src/consumer.cjs', 'concurrent content\n');
    const advancedTip = git(advancePath, ['rev-parse', 'HEAD']).trim();
    git(project.path, ['update-ref', `refs/heads/${DEFAULT_INTEGRATION_BRANCH}`, advancedTip]);
    git(project.path, ['worktree', 'remove', '--force', advancePath]);

    await orchestration.processQueue();
    const task = await getTask(second.id);
    expect(task.state).toBe('awaiting_integration');
    expect(task.integrationStatus).toBe('conflict');
    expect(git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim()).toBe(advancedTip);
    const logs = await getLogs(second.id);
    expect(logs.integrations.at(-1)!.state).toBe('rejected');
    expect(logs.integrations.at(-1)!.reason).toContain('conflict');
    expect(fs.readFileSync(path.join(worktree, 'src', 'consumer.cjs'), 'utf8')).toBe(
      CONSUMER_SOURCE,
    );
    expect(gitResult(project.path, ['rev-parse', '--verify', `refs/heads/${branch}`]).status).toBe(0);

    // A compare-and-swap against a stale ref never overwrites the target.
    const staleSwap = await updateBranchRef(
      project.path,
      DEFAULT_INTEGRATION_BRANCH,
      git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim(),
      'f'.repeat(40),
    );
    expect(staleSwap).toBe(false);
    expect(git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim()).toBe(advancedTip);
  }, 45_000);

  it('preserves dirty or unexpectedly advanced dependent worktrees and rejects the start', async () => {
    const { project, session, second, integrationCommit } = await dependentFixture(
      'guarded',
      'Guarded Worktree Project',
      { pauseScheduling: true },
    );
    const worktree = second.workspace!.workingDirectory;
    const branch = second.workspace!.branchName;
    const originalBase = git(project.path, ['rev-parse', `refs/heads/${branch}`]).trim();
    expect(originalBase).not.toBe(integrationCommit);

    expect(fs.existsSync(profileEvidence(second.toolProfileId))).toBe(false);
    const scratch = path.join(worktree, 'src', 'scratch.txt');
    fs.writeFileSync(scratch, 'keep me\n');
    await configure(project.id, { schedulingPaused: false });
    const dirtySchedule = await orchestration.scheduleSession(session.id);
    expect(dirtySchedule.scheduled).toContain(second.id);
    const dirtyTask = await getTask(second.id);
    expect(dirtyTask.state).toBe('failed');
    expect(dirtyTask.blockedReason).toContain('uncommitted or untracked');
    expect(fs.readFileSync(scratch, 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(profileEvidence(second.toolProfileId))).toBe(false);
    expect(git(project.path, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(originalBase);
    expect(workspaceRecord(second.id).base_commit).toBe(originalBase);

    git(worktree, ['add', '-A']);
    git(worktree, ['commit', '-qm', 'unexpected local work']);
    const unexpectedHead = git(worktree, ['rev-parse', 'HEAD']).trim();
    orchestration.retryTask(second.id);
    const advancedSchedule = await orchestration.scheduleSession(session.id);
    expect(advancedSchedule.scheduled).toContain(second.id);
    const advancedTask = await getTask(second.id);
    expect(advancedTask.state).toBe('failed');
    expect(advancedTask.blockedReason).toContain('commits beyond its recorded base');
    expect(git(project.path, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(unexpectedHead);
    expect(fs.readFileSync(scratch, 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(profileEvidence(second.toolProfileId))).toBe(false);
    expect(workspaceRecord(second.id).base_commit).toBe(originalBase);

    // Restoring the baseline explicitly (never a destructive reset) recovers.
    git(project.path, ['update-ref', `refs/heads/${branch}`, originalBase]);
    fs.rmSync(scratch, { force: true });
    git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
    expect(gitResult(worktree, ['status', '--porcelain']).stdout.trim()).toBe('');
    orchestration.retryTask(second.id);
    const recovered = await orchestration.scheduleSession(session.id);
    expect(recovered.scheduled).toContain(second.id);
    await waitUntil(
      () => fs.existsSync(profileEvidence(second.toolProfileId)),
      'The dependent agent CLI was never started after recovery',
    );
    expect((await getTask(second.id)).state).toBe('running');
    expect(
      fs.readFileSync(path.join(worktree, 'src', 'feature.cjs'), 'utf8').replace(/\r\n/g, '\n'),
    ).toBe(FEATURE_SOURCE);
    expect(git(project.path, ['rev-parse', `refs/heads/${branch}`]).trim()).toBe(integrationCommit);
  }, 60_000);

  it('keeps queued integrations across a restart and never duplicates the task', async () => {
    const { project, session, second, integrationCommit } = await dependentFixture(
      'restart',
      'Restart Project',
    );
    await startDependent(session, second);
    await waitForAgentExit(session.id, second.id);
    commitConsumer(second.workspace!.workingDirectory);
    await authorized('post', `/api/orchestration/tasks/${second.id}/complete`).send({
      summary: 'Added the consumer.',
    });
    await orchestration.enqueueIntegration(second.id, { acknowledgeNoValidation: true });
    const integrationCount = (): number =>
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM task_integrations WHERE task_id = ?')
          .get(second.id) as { count: number }
      ).count;
    expect(integrationCount()).toBe(1);

    const restarted = new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: 2,
      maxLiveTerminals: 8,
      runtimeDir: config.runtimeDir,
    });
    restarted.recover();
    const queued = await getTask(second.id);
    expect(queued.state).toBe('awaiting_integration');
    expect(queued.integrationStatus).toBe('queued');

    await restarted.processQueue();
    await restarted.processQueue();
    expect(git(project.path, ['rev-parse', DEFAULT_INTEGRATION_BRANCH]).trim()).not.toBe(
      integrationCommit,
    );
    expect(integrationCount()).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM agent_tasks WHERE id = ?').get(second.id) as {
        count: number;
      }).count,
    ).toBe(1);
    const finalTask = await getTask(second.id);
    expect(finalTask.state).toBe('integrated');
    expect(finalTask.integrationStatus).toBe('integrated');
    expect(targetTreeFile(project.path, 'src/consumer.cjs')).toBe(CONSUMER_SOURCE);
  }, 45_000);
});

describe('scheduler watchdog', () => {
  it('does not block subsequent ticks when a tick times out', async () => {
    const project = await makeProject('Watchdog Project');
    addProfile('watchdog-agent', 5_000);

    const session = await createSession(project.id, ['watchdog-agent'], [
      { description: 'First task', declaredFileScope: ['src'] },
    ]);
    const terminal = session.terminals[0]!;
    await waitForAgentExit(session.id, terminal.id);
    await stopSession(session.id);
    commitFile(terminal.workspace!.workingDirectory, 'src/done.txt', 'done\n');
    await authorized('post', `/api/orchestration/tasks/${terminal.id}/complete`).send({
      summary: 'Completed work',
    });
    const integrated = await authorized('post', `/api/orchestration/tasks/${terminal.id}/integrate`).send({
      acknowledgeNoValidation: true,
    });
    expect(integrated.status).toBe(200);
    expect(integrated.body.task.state).toBe('integrated');

    // Test the serializeTick timeout directly by creating an orchestration with a short timeout
    // and verifying that a slow operation in the tick chain times out but the chain continues
    const watchdogOrchestration = new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: 2,
      maxLiveTerminals: 8,
      runtimeDir: config.runtimeDir,
      schedulerTickTimeoutMs: 100, // Very short timeout
    });

    // Create a slow operation that exceeds the 100ms timeout
    const slowOperation = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return 'done';
    };

    // First tick with slow operation - should timeout
    const firstTick = watchdogOrchestration['serializeTick'](slowOperation);
    await expect(firstTick).rejects.toThrow(/timed out/);

    // Second tick with fast operation - should succeed (chain not blocked)
    const fastOperation = async (): Promise<string> => {
      return 'fast';
    };
    const secondTick = watchdogOrchestration['serializeTick'](fastOperation);
    await expect(secondTick).resolves.toBe('fast');

    // Clean up
    await waitForAgentExit(session.id, terminal.id);
    await stopSession(session.id);
  }, 30_000);
});
