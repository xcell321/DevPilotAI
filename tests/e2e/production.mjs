import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-production-e2e-'));
const dbPath = path.join(tempRoot, 'production.db');
const runtimeDir = path.join(tempRoot, 'runtime');
const runtimeFile = path.join(runtimeDir, 'server.json');
const projectDir = path.join(tempRoot, 'Production Terminal Project');
const fixtureScript = path.join(tempRoot, 'production-terminal-fixture.cjs');
const fixtureEvidence = path.join(tempRoot, 'production-terminal-evidence.json');
const serverEntry = path.join(root, 'server', 'dist', 'index.js');
const webDist = path.join(root, 'apps', 'web', 'dist');
const serverOutput = [];

fs.mkdirSync(projectDir, { recursive: true });
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
    'x-devpilot-token': runtime.token,
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
    indexHtml.includes('name="devpilot-token"'),
    'Production HTML does not carry the local WebSocket token injection',
  );

  const toolDb = new Database(dbPath);
  toolDb
    .prepare(
      `INSERT INTO tool_profiles (
         id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
         launch_verified, last_status, last_checked_at, notes
       ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
    )
    .run(
      'production-echo',
      'Production Echo CLI',
      process.execPath,
      JSON.stringify([fixtureScript, fixtureEvidence]),
      new Date().toISOString(),
      'Test-only profile for the production WebSocket smoke test.',
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
  assert(isAlive(pid), 'Production terminal pid is not alive');
  await waitUntil(() => fs.existsSync(fixtureEvidence), 'Production terminal evidence is missing');
  const evidence = JSON.parse(fs.readFileSync(fixtureEvidence, 'utf8'));
  assert(
    path.resolve(evidence.cwd) === fs.realpathSync.native(projectDir),
    'Production terminal launched in the wrong cwd',
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
    () => document.querySelector('meta[name="devpilot-token"]')?.getAttribute('content'),
  );
  assert(browserToken === runtime.token, 'Browser token does not match the running server token');
  await page.getByTestId(`terminal-panel-${terminalId}`).waitFor({
    state: 'visible',
    timeout: 20000,
  });
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
  await waitUntil(() => !isAlive(pid), 'Production terminal process survived stop');
  console.log('PASS production workspace stopped the owned terminal process');

  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`);
  console.log('\nP4 production browser smoke passed.');
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  if (page) {
    console.error(`Page URL: ${page.url()}`);
    const metaToken = await page
      .evaluate(() => document.querySelector('meta[name="devpilot-token"]')?.getAttribute('content'))
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
