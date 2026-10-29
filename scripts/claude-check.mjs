import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import protocol from '../shared/protocol.cjs';

const { RUNTIME_FILE_NAME, TOKEN_HEADER } = protocol;
const root = path.resolve(import.meta.dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-claude-'));
const projectDir = path.join(tempRoot, 'claude-cwd-proof');
const runtimeDir = path.join(tempRoot, 'runtime');
const runtimeFile = path.join(runtimeDir, RUNTIME_FILE_NAME);
const dbPath = path.join(tempRoot, 'claude.db');
const serverEntry = path.join(root, 'server', 'dist', 'index.js');
const webDist = path.join(root, 'apps', 'web', 'dist');
const serverOutput = [];

fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'README.md'), '# Temporary Claude integration folder\n');

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

function processTable() {
  if (process.platform !== 'win32') return [];
  const command =
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert(result.status === 0, 'Could not inspect the Windows process table');
  const parsed = JSON.parse(result.stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function processTreePids(rootPid) {
  const table = processTable();
  const children = new Map();
  for (const entry of table) {
    const parent = Number(entry.ParentProcessId);
    const child = Number(entry.ProcessId);
    const list = children.get(parent) ?? [];
    list.push(child);
    children.set(parent, list);
  }
  const result = [rootPid];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (!result.includes(child)) {
        result.push(child);
        queue.push(child);
      }
    }
  }
  return result;
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
  throw new Error(`Server did not write an isolated runtime file: ${lastError?.message ?? 'timeout'}`);
}

let server = null;
let browser = null;
let page = null;
try {
  assert(fs.existsSync(serverEntry), 'Build the server first with "npm run build"');
  assert(
    fs.existsSync(path.join(webDist, 'index.html')),
    'Build the web app first with "npm run build"',
  );
  assert(
    path.resolve(projectDir).startsWith(path.resolve(os.tmpdir())),
    'Claude integration refused to use a non-temporary project folder',
  );

  server = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      DEVPILOT_DB_PATH: dbPath,
      DEVPILOT_RUNTIME_DIR: runtimeDir,
      DEVPILOT_PORT: '0',
      DEVPILOT_MAX_TERMINALS: '2',
      DEVPILOT_WEB_DIST: webDist,
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

  const tools = (await api('/api/tools')).tools;
  const claude = tools.find((tool) => tool.id === 'claude');
  assert(claude, 'Claude profile is missing');
  assert(claude.launchVerified, 'Claude is not marked launch-verified');
  assert(claude.defaultOnQuickStart, 'Claude is not a Quick Start default');
  console.log(`PASS Claude profile is verified and Quick Start enabled (${claude.command})`);

  const { project } = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ path: projectDir, name: 'Claude Integration Temp Project' }),
  });
  assert(
    path.resolve(project.path) === path.resolve(fs.realpathSync.native(projectDir)),
    'Project path was not canonicalized to the temporary folder',
  );

  const { session: created } = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ projectId: project.id, mode: 'quick' }),
  });
  assert(created.terminals.length === 1, 'Quick Start did not create exactly one Claude terminal');
  assert(created.terminals[0].toolProfileId === 'claude', 'Quick Start did not select Claude');
  const sessionId = created.id;
  const terminalId = created.terminals[0].id;
  console.log('PASS production API created a Quick Start Claude session in the temporary DB');

  let session = null;
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    session = result.sessions.find((entry) => entry.id === sessionId) ?? null;
    const terminal = session?.terminals.find((entry) => entry.id === terminalId);
    if (terminal?.status === 'error') {
      throw new Error(`Claude terminal failed: ${terminal.lastError ?? terminal.errorCode}`);
    }
    return session?.status === 'running';
  }, 'Claude terminal did not reach running', 30000);

  const terminal = session.terminals.find((entry) => entry.id === terminalId);
  const rootPid = terminal.pid;
  assert(isAlive(rootPid), 'Claude terminal pid is not alive');
  assert(
    path.resolve(session.project.path) === path.resolve(fs.realpathSync.native(projectDir)),
    'Session launch cwd evidence does not match the temporary project folder',
  );
  console.log(`PASS Claude is running from the temporary project cwd (pid ${rootPid}, no input sent)`);

  const treeBeforeStop = processTreePids(rootPid);
  await wait(3000);
  const stillRunning = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  assert(stillRunning?.status === 'running', 'Claude exited without input during the observation window');
  assert(isAlive(rootPid), 'Claude root process exited without input');
  console.log(`PASS Claude remained interactive without input (${treeBeforeStop.length} process(es) in tree)`);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const terminalText = async () =>
    (await page
      .locator(`[data-testid="terminal-screen-${terminalId}"] .xterm-rows`)
      .textContent()) ?? '';
  const waitForTerminalText = (text, timeout = 30000) =>
    page.waitForFunction(
      ({ id, expected }) =>
        globalThis.document
          .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
          ?.textContent?.includes(expected),
      { id: terminalId, expected: text },
      { timeout },
    );
  const focusTerminal = () =>
    page.getByTestId(`terminal-screen-${terminalId}`).click({ position: { x: 80, y: 60 } });

  const completeClaudeOnboarding = async (timeoutMs = 60000) => {
    const started = Date.now();
    let themeAccepted = false;
    let trustAccepted = false;
    while (Date.now() - started < timeoutMs) {
      const text = await terminalText();
      if (
        text.includes('API Usage Billing') ||
        text.includes('accept edits on') ||
        text.includes('Try "edit')
      ) {
        return { themeAccepted, trustAccepted };
      }
      if (text.includes('Choose the text style') && !themeAccepted) {
        await focusTerminal();
        await page.keyboard.press('Enter');
        themeAccepted = true;
        await wait(1000);
        continue;
      }
      if (text.includes('trust this folder') && !trustAccepted) {
        await focusTerminal();
        await page.keyboard.press('ArrowDown');
        await wait(250);
        await page.keyboard.press('Enter');
        trustAccepted = true;
        await wait(1200);
        continue;
      }
      await wait(400);
    }
    throw new Error(`Claude onboarding did not finish. Terminal text: ${await terminalText()}`);
  };

  await page.goto(`${runtime.origin}/terminals?session=${sessionId}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({
    state: 'visible',
    timeout: 20000,
  });
  const onboarding = await completeClaudeOnboarding();
  assert(
    onboarding.themeAccepted || onboarding.trustAccepted,
    'Claude returned to the main UI without showing expected first-run onboarding',
  );
  console.log(
    `PASS Claude first-run onboarding completed through xterm (theme: ${onboarding.themeAccepted}, trust: ${onboarding.trustAccepted})`,
  );

  const dimensionsBefore = /(\d+)x(\d+)/.exec(
    (await page.getByTestId(`terminal-dimensions-${terminalId}`).textContent()) ?? '',
  );
  assert(dimensionsBefore, 'Claude terminal dimensions were not reported');
  await page.setViewportSize({ width: 1000, height: 700 });
  await waitUntil(async () => {
    const ptySize = await page
      .getByTestId(`terminal-panel-${terminalId}`)
      .getAttribute('data-pty-size');
    const current = /(\d+)x(\d+)/.exec(
      (await page.getByTestId(`terminal-dimensions-${terminalId}`).textContent()) ?? '',
    );
    return Boolean(
      current &&
        Number(current[1]) !== Number(dimensionsBefore[1]) &&
        ptySize === `${current[1]}x${current[2]}`,
    );
  }, 'Claude did not acknowledge the resized terminal dimensions', 20000);
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log('PASS real Claude PTY acknowledged an xterm resize from the workspace');

  await focusTerminal();
  await page.keyboard.type('/status');
  await page.keyboard.press('Enter');
  await waitForTerminalText('Version:');
  const statusText = await terminalText();
  assert(statusText.includes('Session kind:'), 'Claude status panel is missing the session kind');
  assert(statusText.includes('interactive'), 'Claude status panel is not an interactive session');
  assert(statusText.includes('cwd:'), 'Claude status panel is missing the cwd');
  console.log('PASS /status ran inside Claude through the browser terminal');

  await page.keyboard.press('Escape');
  await wait(500);
  const treeBeforeExit = processTreePids(rootPid);
  await focusTerminal();
  await page.keyboard.type('/exit');
  await page.keyboard.press('Enter');
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    const current = result.sessions.find((entry) => entry.id === sessionId);
    const exited = current?.terminals.find((entry) => entry.id === terminalId);
    return exited?.status !== 'running' && exited?.status !== 'starting';
  }, 'Claude did not exit from the /exit command', 20000);
  await waitUntil(
    () => treeBeforeExit.every((pid) => !isAlive(pid)),
    `Claude process tree survived /exit: ${treeBeforeExit.filter(isAlive).join(', ')}`,
  );
  console.log('PASS /exit closed Claude and cleaned up its process tree');

  await page.getByTestId(`restart-terminal-${terminalId}`).click();
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    const current = result.sessions.find((entry) => entry.id === sessionId);
    return current?.terminals.find((entry) => entry.id === terminalId)?.status === 'running';
  }, 'Restarted Claude terminal did not reach running', 30000);
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-connection-${terminalId}`).textContent())?.includes(
        'Live',
      ),
    'Restarted Claude terminal did not reconnect over WebSocket',
  );
  await wait(800);
  await completeClaudeOnboarding();
  session = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  const restartedTerminal = session.terminals.find((entry) => entry.id === terminalId);
  const restartedPid = restartedTerminal.pid;
  assert(restartedPid && restartedPid !== rootPid && isAlive(restartedPid), 'Claude restart failed');
  const restartedTree = processTreePids(restartedPid);
  await wait(1000);
  assert(isAlive(restartedPid), 'Restarted Claude exited without input');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('stop-session-workspace').click();
  await waitUntil(async () => {
    const result = await api('/api/sessions');
    const stopped = result.sessions.find((entry) => entry.id === sessionId);
    return stopped?.status === 'stopped';
  }, 'Claude session did not settle to stopped');
  await waitUntil(
    () => restartedTree.every((pid) => !isAlive(pid)),
    `Claude process tree survived stop: ${restartedTree.filter(isAlive).join(', ')}`,
  );
  const stoppedSession = (await api('/api/sessions')).sessions.find((entry) => entry.id === sessionId);
  assert(stoppedSession.status === 'stopped', 'Stopped session report is not stopped');
  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`);
  console.log('PASS workspace restart and Stop session controlled the real Claude process tree');

  console.log('\nClaude integration smoke passed.');
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  if (page) {
    console.error(`Page URL: ${page.url()}`);
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.error(`Page text: ${bodyText.slice(-4000)}`);
  }
  const tail = serverOutput.join('').trim().slice(-2000);
  if (tail) console.error(`Server output tail:\n${tail}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killTree(server?.pid);
  await wait(500);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // The OS temp folder is harmless if a Windows handle lingers briefly.
  }
}
