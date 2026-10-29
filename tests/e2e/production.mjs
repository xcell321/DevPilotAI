import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-core';
import protocol from '../../shared/protocol.cjs';

const { RUNTIME_FILE_NAME, TOKEN_HEADER, TOKEN_META_NAME } = protocol;
const root = path.resolve(import.meta.dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dpe-'));
const dbPath = path.join(tempRoot, 'production.db');
const runtimeDir = path.join(tempRoot, 'runtime');
const runtimeFile = path.join(runtimeDir, RUNTIME_FILE_NAME);
const projectDir = path.join(tempRoot, 'Production Terminal Project');
const fixtureScript = path.join(tempRoot, 'production-terminal-fixture.cjs');
const fixtureEvidence = path.join(tempRoot, 'production-terminal-evidence.json');
const workflowFixtureEvidence = path.join(tempRoot, 'production-workflow-evidence.json');
const secondFixtureEvidence = path.join(tempRoot, 'production-terminal-evidence-b.json');
const thirdFixtureEvidence = path.join(tempRoot, 'production-terminal-evidence-c.json');
const fourthFixtureEvidence = path.join(tempRoot, 'production-terminal-evidence-d.json');
const serverEntry = path.join(root, 'server', 'dist', 'index.js');
const webDist = path.join(root, 'apps', 'web', 'dist');
const serverOutput = [];

fs.mkdirSync(projectDir, { recursive: true });
const gitInitialized = spawnSync('git', ['-C', projectDir, 'init', '--quiet'], {
  encoding: 'utf8',
  windowsHide: true,
});
if (gitInitialized.status !== 0) {
  throw new Error(`Could not initialize production test repository: ${gitInitialized.stderr}`);
}
const gitCommit = spawnSync(
  'git',
  [
    '-C',
    projectDir,
    '-c',
    'user.name=DevPilot E2E',
    '-c',
    'user.email=devpilot-e2e@example.invalid',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'Initial',
  ],
  { encoding: 'utf8', windowsHide: true },
);
if (gitCommit.status !== 0) {
  throw new Error(`Could not commit production test repository: ${gitCommit.stderr}`);
}
fs.writeFileSync(
  fixtureScript,
  `const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
process.stdout.write('PRODUCTION_READY\\r\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'exit') {
    process.stdout.write('PRODUCTION_EXIT\\r\\n');
    setTimeout(() => process.exit(0), 60);
    return;
  }
  process.stdout.write('PRODUCTION_ECHO:' + line + '\\r\\n');
});
setInterval(() => {}, 1000);
`,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check, message, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await wait(150);
  }
  throw new Error(message);
}

function findAdjacentSplit(node, firstId, secondId) {
  if (!node || node.type === 'terminal') return null;
  const firstLeaf = node.first.type === 'terminal' ? node.first.terminalId : null;
  const secondLeaf = node.second.type === 'terminal' ? node.second.terminalId : null;
  if (
    (firstLeaf === firstId && secondLeaf === secondId) ||
    (firstLeaf === secondId && secondLeaf === firstId)
  ) {
    return node;
  }
  return findAdjacentSplit(node.first, firstId, secondId) ??
    findAdjacentSplit(node.second, firstId, secondId);
}

function assertSavedPlacement(layout, newId, targetId, direction, newFirst) {
  const split = findAdjacentSplit(layout.tree, newId, targetId);
  assert(split, `Saved layout does not place ${newId} beside ${targetId}`);
  assert(split.direction === direction, `Expected a ${direction} split`);
  assert(
    (split.first.type === 'terminal' && split.first.terminalId === newId) === newFirst,
    `New terminal ${newFirst ? 'should precede' : 'should follow'} its target`,
  );
}

function splitTestIds(node, path = []) {
  if (!node || node.type === 'terminal') return [];
  const testId =
    path.length === 0 ? 'split-root' : `split-${path.map((branch) => (branch ? '1' : '0')).join('')}`;
  return [
    testId,
    ...splitTestIds(node.first, [...path, true]),
    ...splitTestIds(node.second, [...path, false]),
  ];
}

function killTree(pid) {
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

async function readRuntime() {
  let lastError = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      if (runtime.origin && runtime.token) return runtime;
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Production server did not publish its runtime file: ${lastError?.message}`);
}

let server = null;
let browser = null;
let page = null;

try {
  assert(fs.existsSync(serverEntry), 'Build the server first with "npm run build"');
  assert(fs.existsSync(path.join(webDist, 'index.html')), 'Build the web app first with "npm run build"');

  server = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      DEVPILOT_DB_PATH: dbPath,
      DEVPILOT_RUNTIME_DIR: runtimeDir,
      DEVPILOT_PORT: '0',
      DEVPILOT_MAX_TERMINALS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => serverOutput.push(chunk.toString()));
  server.stderr.on('data', (chunk) => serverOutput.push(chunk.toString()));

  const runtime = await readRuntime();
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    [TOKEN_HEADER]: runtime.token,
  };
  const api = async (pathname, options = {}) => {
    const response = await fetch(`${runtime.origin}${pathname}`, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error?.message ?? `API request failed with ${response.status}`);
    }
    return body;
  };

  const indexResponse = await fetch(runtime.origin);
  assert(indexResponse.ok, 'Production server did not serve the built web app');
  const indexHtml = await indexResponse.text();
  assert(
    indexHtml.includes(`name="${TOKEN_META_NAME}"`),
    'Production HTML does not carry the local WebSocket token injection',
  );

  const toolDb = new Database(dbPath);
  const insertTestTool = toolDb.prepare(
    `INSERT INTO tool_profiles (
       id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
       launch_verified, last_status, last_checked_at, notes
     ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
  );
  for (const [id, displayName, evidence] of [
    ['production-workflow', 'Automatic Workflow Test CLI', workflowFixtureEvidence],
    ['production-echo', 'Production Echo CLI', fixtureEvidence],
    ['production-echo-b', 'Production Echo CLI B', secondFixtureEvidence],
    ['production-echo-c', 'Production Echo CLI C', thirdFixtureEvidence],
    ['production-echo-d', 'Production Echo CLI D', fourthFixtureEvidence],
    ['production-disabled', 'Production Disabled CLI', fixtureEvidence],
  ]) {
    insertTestTool.run(
      id,
      displayName,
      process.execPath,
      JSON.stringify([fixtureScript, evidence]),
      new Date().toISOString(),
      'Test-only profile for the production split workspace test.',
    );
  }
  toolDb
    .prepare(
      `UPDATE tool_profiles SET enabled = 0
       WHERE id NOT IN (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'production-workflow',
      'production-echo',
      'production-echo-b',
      'production-echo-c',
      'production-echo-d',
      'production-disabled',
    );
  toolDb.close();

  const { project } = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ path: projectDir, name: 'Production Terminal Project' }),
  });
  const { session: created } = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      mode: 'custom',
      workspaceMode: 'isolated',
      toolIds: ['production-echo'],
    }),
  });
  assert(created.terminals.length === 1, 'Production session did not create one terminal');
  const sessionId = created.id;
  const terminalId = created.terminals[0].id;

  let session = created;
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    session = result.sessions.find((entry) => entry.id === sessionId);
    return session?.terminals[0]?.status === 'running';
  }, 'Production terminal did not reach running');
  const pid = session.terminals[0].pid;
  const initialWorkspacePath = session.terminals[0].workspace.path;
  assert(isAlive(pid), 'Production terminal pid is not alive');
  await waitUntil(() => fs.existsSync(fixtureEvidence), 'Production terminal evidence is missing');
  const evidence = JSON.parse(fs.readFileSync(fixtureEvidence, 'utf8'));
  assert(
    session.terminals[0].workspace?.status === 'ready' &&
      path.resolve(evidence.cwd) ===
        path.resolve(session.terminals[0].workspace.workingDirectory),
    'Production terminal did not launch in its assigned isolated workspace',
  );

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  const socketUrls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('websocket', (socket) => socketUrls.push(socket.url()));

  await page.goto(`${runtime.origin}/terminals?session=${sessionId}`, {
    waitUntil: 'domcontentloaded',
  });
  const browserToken = await page.evaluate(
    (metaName) => document.querySelector(`meta[name="${metaName}"]`)?.getAttribute('content'),
    TOKEN_META_NAME,
  );
  assert(browserToken === runtime.token, 'Browser token does not match the running server token');
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({
    state: 'visible',
    timeout: 20000,
  });
  await page.getByTestId('workflow-project').selectOption(project.id);
  await page.getByTestId('workflow-prompt').fill('Add a project health check endpoint');
  await page.getByTestId('generate-workflow').click();
  await page.getByTestId('workflow-plan-review').waitFor({ state: 'visible' });
  const sessionsBeforeWorkflowStart = await api('/api/sessions');
  assert(
    sessionsBeforeWorkflowStart.sessions.length === 1,
    'Generating a workflow created a session before the plan was reviewed and started',
  );
  await page.getByTestId('start-workflow').click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="workflow-progress"]')
        ?.textContent?.includes('Workflow running'),
    undefined,
    { timeout: 20000 },
  );
  let workflowSession = null;
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    workflowSession = result.sessions.find((entry) => entry.id !== sessionId) ?? null;
    return workflowSession?.terminals[0]?.status === 'running';
  }, 'Reviewed workflow did not start its real CLI process');
  assert(
    workflowSession.workspaceMode === 'isolated' &&
      workflowSession.terminals[0].workspace?.status === 'ready' &&
      isAlive(workflowSession.terminals[0].pid),
    'The workflow CLI did not receive a live isolated worktree',
  );
  await waitUntil(
    () => fs.existsSync(workflowFixtureEvidence),
    'The workflow CLI did not write its process evidence',
  );
  const workflowProgress = await page.getByTestId('workflow-progress').textContent();
  assert(workflowProgress?.includes('Workflow running'), 'The active workflow status was not rendered');
  console.log('PASS production UI reviewed a generated plan before starting its isolated CLI task');
  await api(`/api/sessions/${workflowSession.id}/stop`, { method: 'POST' });
  await page.goto(`${runtime.origin}/terminals?session=${sessionId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({ state: 'visible' });
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
        ?.textContent?.includes('PRODUCTION_READY'),
    terminalId,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="terminal-connection-${id}"]`)
        ?.textContent?.includes('Live'),
    terminalId,
    { timeout: 20000 },
  );
  assert(socketUrls.length > 0, 'The browser did not open a terminal WebSocket');
  assert(
    socketUrls.every((url) => !url.includes(runtime.token)),
    'The local token was exposed in a terminal WebSocket URL',
  );
  console.log('PASS production server served the built UI and same-origin terminal WebSocket');

  await page.getByTestId(`terminal-screen-${terminalId}`).click({ position: { x: 80, y: 60 } });
  await page.keyboard.type('production-input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
        ?.textContent?.includes('PRODUCTION_ECHO:production-input'),
    terminalId,
    { timeout: 20000 },
  );
  console.log('PASS production xterm input reached the real terminal process');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({
    state: 'visible',
    timeout: 20000,
  });
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
        ?.textContent?.includes('PRODUCTION_ECHO:production-input'),
    terminalId,
    { timeout: 20000 },
  );
  session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  assert(session.terminals[0].pid === pid, 'Production reload replaced the terminal process');
  assert(isAlive(pid), 'Production terminal process died during reload');
  console.log('PASS production reload reattached to the same live process with replay');

  await page.getByTestId(`maximize-terminal-${terminalId}`).click();
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({
    state: 'visible',
    timeout: 5000,
  });
  assert(
    (await page.getByTestId(`terminal-panel-${terminalId}`).getAttribute('class')).includes(
      'terminal-panel-maximized',
    ),
    'Terminal did not maximize',
  );
  await page.getByTestId(`maximize-terminal-${terminalId}`).click();
  console.log('PASS terminal maximize and restore controls updated the real xterm panel');

  fs.rmSync(fixtureEvidence, { force: true });
  await page.getByTestId('add-terminal-choice').selectOption('tool:production-echo-b');
  await page.getByTestId('split-terminal-right').click();
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.length === 2;
  }, 'Split-right did not add the second terminal');
  let terminalB = session.terminals.find(
    (terminal) => terminal.toolProfileId === 'production-echo-b',
  );
  const terminalBId = terminalB.id;
  await page.getByTestId(`terminal-panel-${terminalBId}`).waitFor({ state: 'visible' });
  assertSavedPlacement(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
      sessionId,
    ),
    terminalBId,
    terminalId,
    'horizontal',
    false,
  );
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    terminalB = session.terminals.find((terminal) => terminal.id === terminalBId);
    return terminalB.status === 'running' || terminalB.status === 'error';
  }, 'Second terminal did not start');
  assert(
    terminalB.status === 'running',
    `Second terminal failed: ${terminalB.lastError ?? terminalB.errorCode ?? terminalB.status}`,
  );
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
        ?.textContent?.includes('PRODUCTION_READY'),
    terminalBId,
    { timeout: 20000 },
  );
  await waitUntil(
    () => fs.existsSync(secondFixtureEvidence),
    'Second terminal did not write its worktree evidence',
  );
  const evidenceB = JSON.parse(fs.readFileSync(secondFixtureEvidence, 'utf8'));
  assert(
    path.resolve(evidenceB.cwd) === path.resolve(terminalB.workspace.workingDirectory),
    'Second terminal did not use its assigned worktree',
  );
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.find((terminal) => terminal.id === terminalId)?.pid === pid;
  }, 'Adding a terminal changed the existing isolated process');
  const preservedTerminal = session.terminals.find((terminal) => terminal.id === terminalId);
  const restartCountBeforeRestart = preservedTerminal.restartCount;
  assert(isAlive(preservedTerminal.pid), 'Existing isolated terminal process is not alive');
  assert(
    preservedTerminal.workspace.path === initialWorkspacePath,
    'Adding a terminal reassigned the existing worktree',
  );
  console.log('PASS adding an isolated terminal preserved the existing PTY and workspace');

  fs.rmSync(fixtureEvidence, { force: true });
  await page.getByTestId(`restart-terminal-${terminalId}`).click();
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    const restarted = session.terminals.find((terminal) => terminal.id === terminalId);
    return (
      restarted?.status === 'running' &&
      restarted.restartCount > restartCountBeforeRestart
    );
  }, 'Original terminal did not restart in its isolated worktree');
  const restartedTerminal = session.terminals.find((terminal) => terminal.id === terminalId);
  assert(restartedTerminal.restartCount > restartCountBeforeRestart, 'Terminal restart was not recorded');
  await waitUntil(
    () => fs.existsSync(fixtureEvidence),
    'Restarted terminal did not write its worktree evidence',
  );
  const restartedEvidence = JSON.parse(fs.readFileSync(fixtureEvidence, 'utf8'));
  assert(
    restartedEvidence.pid === restartedTerminal.pid && isAlive(restartedTerminal.pid),
    'Restarted terminal evidence does not match the live process',
  );
  assert(
    session.terminals.every((terminal) => terminal.workspace?.status === 'ready'),
    'Converted multi-terminal session does not have ready worktrees',
  );
  assert(
    path.resolve(restartedEvidence.cwd) ===
      path.resolve(restartedTerminal.workspace.workingDirectory),
    'Restarted terminal did not use its assigned worktree',
  );
  assert(
    new Set(session.terminals.map((terminal) => terminal.workspace.path)).size === 2,
    'The two terminals do not have distinct worktrees',
  );
  console.log('PASS split-right retained separate worktrees and the original workspace ownership');

  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.every(
      (terminal) => terminal.status === 'running' && terminal.pid !== null,
    );
  }, 'Existing terminals did not settle before testing rejected creation');
  const layoutBeforeRejectedAdd = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  const pidsBeforeRejectedAdd = new Map(
    session.terminals.map((terminal) => [terminal.id, terminal.pid]),
  );
  const updateDb = new Database(dbPath);
  updateDb.prepare('UPDATE tool_profiles SET enabled = 0 WHERE id = ?').run('production-disabled');
  updateDb.close();
  await page.getByTestId('add-terminal-choice').selectOption('tool:production-disabled');
  await page.getByTestId('split-terminal-right').click();
  await page.waitForFunction(() =>
    document
      .querySelector('[role="alert"]')
      ?.textContent?.includes('disabled in the CLI registry'),
  );
  const layoutAfterRejectedAdd = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  assert(
    JSON.stringify(layoutAfterRejectedAdd.tree) === JSON.stringify(layoutBeforeRejectedAdd.tree),
    'Rejected terminal creation changed the saved split tree',
  );
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.every((terminal) => terminal.status === 'running');
  }, 'Rejected terminal creation disturbed an existing process');
  assert(
    session.terminals.length === 2 &&
      session.terminals.every(
        (terminal) =>
          terminal.pid === pidsBeforeRejectedAdd.get(terminal.id) && isAlive(terminal.pid),
      ),
    'Rejected terminal creation changed existing session processes',
  );
  console.log('PASS rejected terminal creation surfaced the reason and preserved the workspace');

  await page.getByTestId('add-terminal-choice').selectOption('tool:production-echo-c');
  await page.getByTestId(`split-terminal-down-${terminalBId}`).click();
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.length === 3;
  }, 'Split-down did not add the third terminal');
  let terminalC = session.terminals.find(
    (terminal) => terminal.toolProfileId === 'production-echo-c',
  );
  const terminalCId = terminalC.id;
  await page.getByTestId(`terminal-panel-${terminalCId}`).waitFor({ state: 'visible' });
  assertSavedPlacement(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
      sessionId,
    ),
    terminalCId,
    terminalBId,
    'vertical',
    false,
  );
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    terminalC = session.terminals.find((terminal) => terminal.id === terminalCId);
    return terminalC.status === 'running';
  }, 'Third terminal did not start in its worktree');
  await waitUntil(
    () => fs.existsSync(thirdFixtureEvidence),
    'Third terminal did not write its worktree evidence',
  );
  const evidenceC = JSON.parse(fs.readFileSync(thirdFixtureEvidence, 'utf8'));
  assert(
    path.resolve(evidenceC.cwd) === path.resolve(terminalC.workspace.workingDirectory),
    'Third terminal did not use its assigned worktree',
  );
  await waitUntil(
    async () =>
      (await page.locator('[data-testid="split-0"], [data-testid="split-1"]').count()) === 1,
    'Nested split-down layout was not rendered',
  );
  const rootDivider = page.getByTestId('split-divider-root');
  const dividerBefore = await rootDivider.getAttribute('aria-valuenow');
  await rootDivider.focus();
  await page.keyboard.press('ArrowRight');
  await waitUntil(
    async () => (await rootDivider.getAttribute('aria-valuenow')) !== dividerBefore,
    'Keyboard resize did not update the split divider',
  );
  console.log('PASS nested split-down layout and accessible divider resizing worked');

  const pidsBeforeLeftSplit = new Map(
    session.terminals.map((terminal) => [terminal.id, terminal.pid]),
  );
  await page.getByTestId('add-terminal-choice').selectOption('tool:production-echo-d');
  await page.getByTestId(`split-terminal-left-${terminalCId}`).click();
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    return session.terminals.length === 4;
  }, 'Split-left did not add the fourth terminal');
  let terminalD = session.terminals.find(
    (terminal) => terminal.toolProfileId === 'production-echo-d',
  );
  const terminalDId = terminalD.id;
  await page.getByTestId(`terminal-panel-${terminalDId}`).waitFor({ state: 'visible' });
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    terminalD = session.terminals.find((terminal) => terminal.id === terminalDId);
    return terminalD.status === 'running' || terminalD.status === 'error';
  }, 'Fourth terminal did not start');
  assert(
    terminalD.status === 'running',
    `Fourth terminal failed: ${terminalD.lastError ?? terminalD.errorCode ?? terminalD.status}`,
  );
  await waitUntil(
    () => fs.existsSync(fourthFixtureEvidence),
    'Fourth terminal did not write its worktree evidence',
  );
  assert(
    terminalD.workspace?.status === 'ready' &&
      path.resolve(JSON.parse(fs.readFileSync(fourthFixtureEvidence, 'utf8')).cwd) ===
        path.resolve(terminalD.workspace.workingDirectory),
    'Fourth terminal did not use its assigned isolated workspace',
  );
  assertSavedPlacement(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
      sessionId,
    ),
    terminalDId,
    terminalCId,
    'horizontal',
    true,
  );
  assert(
    session.terminals
      .filter((terminal) => terminal.id !== terminalDId)
      .every((terminal) => terminal.pid === pidsBeforeLeftSplit.get(terminal.id)),
    'Adding a terminal changed an existing isolated PTY process',
  );
  assert(
    (await page.getByText('Session terminal limit reached.').count()) === 1,
    'The workspace did not display the authoritative terminal limit',
  );
  assert(
    await page
      .locator('[data-testid="add-terminal-choice"] option[value="tool:production-echo-c"]')
      .isDisabled(),
    'The workspace allowed a new CLI choice beyond its terminal limit',
  );
  console.log('PASS split-left placed the new terminal first without restarting existing PTYs');

  await page.getByTestId('terminal-layout-select').selectOption('grid');
  await waitUntil(async () => {
    const preferences = (await api('/api/settings/workspace')).preferences;
    return preferences.terminalLayout === 'grid';
  }, 'Balanced grid preset was not persisted');
  const gridLayout = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  assert(
    gridLayout.tree.type === 'split' &&
      gridLayout.tree.direction === 'horizontal' &&
      gridLayout.tree.ratio === 0.5 &&
      gridLayout.tree.first.type === 'split' &&
      gridLayout.tree.first.direction === 'vertical' &&
      gridLayout.tree.first.ratio === 0.5 &&
      gridLayout.tree.second.type === 'split' &&
      gridLayout.tree.second.direction === 'vertical' &&
      gridLayout.tree.second.ratio === 0.5,
    'Four terminals did not form an equal-sized 2x2 grid',
  );
  const gridBounds = await page.evaluate((ids) => {
    const rects = ids.map((id) =>
      document.querySelector(`[data-testid="terminal-panel-${id}"]`).getBoundingClientRect(),
    );
    return rects.map(({ x, y, width, height }) => ({ x, y, width, height }));
  }, session.terminals.map((terminal) => terminal.id));
  assert(
    Math.max(...gridBounds.map((bounds) => bounds.width)) -
      Math.min(...gridBounds.map((bounds) => bounds.width)) <= 4 &&
      Math.max(...gridBounds.map((bounds) => bounds.height)) -
        Math.min(...gridBounds.map((bounds) => bounds.height)) <= 4 &&
      new Set(gridBounds.map((bounds) => Math.round(bounds.x))).size === 2 &&
      new Set(gridBounds.map((bounds) => Math.round(bounds.y))).size === 2,
    `The rendered four-terminal grid was not balanced: ${JSON.stringify(gridBounds)}`,
  );
  const pidsBeforeGridReload = new Map(
    session.terminals.map((terminal) => [terminal.id, terminal.pid]),
  );
  await page.getByTestId(`maximize-terminal-${terminalDId}`).click();
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-panel-${terminalDId}`).getAttribute('class')).includes(
        'terminal-panel-maximized',
      ),
    'Focus mode did not maximize the selected terminal',
  );
  await page.getByTestId(`maximize-terminal-${terminalDId}`).click();
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
  await waitUntil(
    async () =>
      /^\d+x\d+$/.test(
        (await page.getByTestId(`terminal-dimensions-${terminalId}`).textContent()) ?? '',
      ),
    'Terminal dimensions were not reported before browser resize',
  );
  const columnsBeforeResize = Number(
    (await page.getByTestId(`terminal-dimensions-${terminalId}`).textContent()).split('x')[0],
  );
  await page.setViewportSize({ width: 900, height: 640 });
  await waitUntil(
    async () =>
      page.evaluate(({ id, columnsBeforeResize }) => {
        const panel = document.querySelector(`[data-testid="terminal-panel-${id}"]`);
        const ptySize = panel?.getAttribute('data-pty-size');
        const dimensions = panel
          ?.querySelector(`[data-testid="terminal-dimensions-${id}"]`)
          ?.textContent?.trim();
        const columns = Number(dimensions?.split('x')[0]);
        return Boolean(
          ptySize &&
            dimensions &&
            ptySize === dimensions &&
            columns < columnsBeforeResize,
        );
      }, { id: terminalId, columnsBeforeResize }),
    'Resizing the browser did not update the PTY dimensions',
  );
  const columnsAfterResize = Number(
    (await page.getByTestId(`terminal-dimensions-${terminalId}`).textContent()).split('x')[0],
  );
  assert(columnsAfterResize < columnsBeforeResize, 'Window resizing did not refit xterm');
  await page.setViewportSize(originalViewport);
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (const terminal of session.terminals) {
    await page.getByTestId(`terminal-panel-${terminal.id}`).waitFor({ state: 'visible' });
  }
  const restoredGrid = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  assert(
    JSON.stringify(restoredGrid.tree) === JSON.stringify(gridLayout.tree),
    'The balanced grid did not restore after reload',
  );
  session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  assert(
    session.terminals.every(
      (terminal) =>
        terminal.pid === pidsBeforeGridReload.get(terminal.id) && isAlive(terminal.pid),
    ),
    'Changing or restoring the layout replaced a terminal process',
  );
  console.log('PASS balanced grid, focus/restore, browser resize, and reload preserved all PTYs');

  const firstFourthTerminalPid = terminalD.pid;
  const firstFourthRestartCount = terminalD.restartCount;
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId(`close-terminal-${terminalDId}`).click();
  await page.getByTestId(`terminal-panel-${terminalDId}`).waitFor({ state: 'detached' });
  await waitUntil(
    () => !isAlive(firstFourthTerminalPid),
    'Closing the fourth terminal did not stop its process',
  );
  await page.getByTestId('add-terminal-choice').selectOption(`terminal:${terminalDId}`);
  const savedBeforeUp = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  const upTargetId = savedBeforeUp.activeTerminalId;
  await page.getByTestId('split-terminal-up').click();
  await page.getByTestId(`terminal-panel-${terminalDId}`).waitFor({ state: 'visible' });
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    terminalD = session.terminals.find((terminal) => terminal.id === terminalDId);
    return (
      terminalD.status === 'running' &&
      terminalD.restartCount > firstFourthRestartCount
    );
  }, 'Reopening the saved terminal above the active panel did not restart its PTY');
  assert(
    isAlive(terminalD.pid),
    'Reopened terminal did not reconnect to a live process',
  );
  assertSavedPlacement(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
      sessionId,
    ),
    terminalDId,
    upTargetId,
    'vertical',
    true,
  );
  console.log('PASS split-up placed a reopened terminal above the active panel');

  const firstThirdTerminalPid = terminalC.pid;
  const firstThirdRestartCount = terminalC.restartCount;
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId(`close-terminal-${terminalCId}`).click();
  await page.getByTestId(`terminal-panel-${terminalCId}`).waitFor({ state: 'detached' });
  await waitUntil(
    () => !isAlive(firstThirdTerminalPid),
    'Closing a split terminal did not stop its process',
  );
  fs.rmSync(thirdFixtureEvidence, { force: true });
  await page.getByTestId('add-terminal-choice').selectOption(`terminal:${terminalCId}`);
  await page.getByTestId('split-terminal-down').click();
  await page.getByTestId(`terminal-panel-${terminalCId}`).waitFor({ state: 'visible' });
  await waitUntil(async () => {
    session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
    terminalC = session.terminals.find((terminal) => terminal.id === terminalCId);
    return (
      terminalC.status === 'running' &&
      terminalC.restartCount > firstThirdRestartCount
    );
  }, 'Reopening the saved terminal did not restart its process');
  await waitUntil(
    () => fs.existsSync(thirdFixtureEvidence),
    'Reopened terminal did not write its worktree evidence',
  );
  assert(
    path.resolve(JSON.parse(fs.readFileSync(thirdFixtureEvidence, 'utf8')).cwd) ===
      path.resolve(terminalC.workspace.workingDirectory),
    'Reopened terminal did not return to its assigned worktree',
  );
  console.log('PASS close stopped the process and reopening restored its saved terminal');

  session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  const pidsBeforeLayoutRestore = new Map(
    session.terminals.map((terminal) => [terminal.id, terminal.pid]),
  );
  const layoutBeforeRestore = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem(`devpilot-terminal-layout-v1:${id}`)),
    sessionId,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (const terminal of session.terminals) {
    await page.getByTestId(`terminal-panel-${terminal.id}`).waitFor({ state: 'visible' });
  }
  for (const testId of splitTestIds(layoutBeforeRestore.tree)) {
    await page.getByTestId(testId).waitFor({ state: 'attached' });
  }
  session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  assert(
    session.terminals.every(
      (terminal) => terminal.pid === pidsBeforeLayoutRestore.get(terminal.id),
    ),
    'Reloading the saved split layout spawned duplicate terminal processes',
  );
  console.log('PASS saved nested layout restored without duplicating terminal processes');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('stop-session-workspace').click();
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    const stopped = result.sessions.find((entry) => entry.id === sessionId);
    return (
      stopped?.status === 'stopped' &&
      stopped.terminals.every((terminal) => terminal.status === 'stopped')
    );
  }, 'Production Stop session did not settle to stopped');
  await waitUntil(
    () => session.terminals.every((terminal) => !isAlive(terminal.pid)),
    'A production terminal process survived stop',
  );
  console.log('PASS production workspace stopped the owned terminal process');

  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`);
  console.log('\nP4 production browser smoke passed.');
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  if (page) {
    console.error(`Page URL: ${page.url()}`);
    const metaToken = await page
      .evaluate(
        (metaName) => document.querySelector(`meta[name="${metaName}"]`)?.getAttribute('content'),
        TOKEN_META_NAME,
      )
      .catch(() => 'unavailable');
    console.error(`Meta token: ${metaToken}`);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.error(`Page text: ${bodyText.slice(0, 2000)}`);
  }
  const tail = serverOutput.join('').trim().slice(-2000);
  if (tail) console.error(`Server output tail:\n${tail}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killTree(server?.pid);
  await wait(600);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Windows may briefly retain a handle; the OS temp folder remains harmless.
  }
}
