import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright-core';
import runtimePaths from '../../shared/runtime-paths.cjs';

const { runtimeFileFor } = runtimePaths;

const root = path.resolve(import.meta.dirname, '..', '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-e2e-'));
const dbPath = path.join(tempRoot, 'e2e.db');
const projectDir = path.join(tempRoot, 'Café 日本語 E2E Project');
const sentinelFile = path.join(projectDir, 'sentinel.txt');
const fixtureScript = path.join(tempRoot, 'e2e-terminal-fixture.cjs');
const fixtureEvidence = path.join(tempRoot, 'e2e-terminal-evidence.json');
const secondFixtureEvidence = path.join(tempRoot, 'e2e-terminal-evidence-2.json');
const runtimeDir = path.join(tempRoot, 'runtime');
const runtimeFile = runtimeFileFor(root, {
  ...process.env,
  DEVPILOT_RUNTIME_DIR: runtimeDir,
});

fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(sentinelFile, 'keep this file');
fs.writeFileSync(
  fixtureScript,
  `const fs = require('node:fs');
const readline = require('node:readline');
const target = process.argv[2];
fs.writeFileSync(target, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
process.stdout.write('E2E_READY\\r\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'exit') {
    process.stdout.write('E2E_EXIT\\r\\n');
    setTimeout(() => process.exit(0), 60);
    return;
  }
  if (line === 'size') {
    process.stdout.write('E2E_SIZE ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n');
    return;
  }
  if (line === 'large') {
    process.stdout.write('L'.repeat(100000) + '\\r\\nE2E_LARGE_END\\r\\n');
    return;
  }
  process.stdout.write('E2E_ECHO:' + line + '\\r\\n');
});
setInterval(() => {}, 1000);
`,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countOccurrences(text, value) {
  return text.split(value).length - 1;
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

async function waitUntil(check, message, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await wait(100);
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
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already exited.
    }
  }
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await wait(250);
  }
  throw new Error(`Web app did not become reachable at ${url}`);
}

const dev = spawn(process.execPath, ['scripts/dev.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    DEVPILOT_DB_PATH: dbPath,
    DEVPILOT_RUNTIME_DIR: runtimeDir,
    DEVPILOT_MAX_TERMINALS_PER_SESSION: '3',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
dev.stdout.on('data', (data) => {
  output += data.toString();
  process.stdout.write(data);
});
dev.stderr.on('data', (data) => {
  output += data.toString();
  process.stderr.write(data);
});

let browser = null;

try {
  const started = Date.now();
  let webUrl = null;
  while (!webUrl) {
    const match = output.match(/Web:\s+(http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      webUrl = match[1];
      break;
    }
    if (Date.now() - started > 30000) {
      throw new Error('Timed out waiting for the dev runner to print the web URL');
    }
    await wait(150);
  }

  await waitForHttp(webUrl);
  const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const serverOrigin = runtime.origin;
  const token = runtime.token;
  await waitForHttp(`${serverOrigin}/api/health`);
  console.log(`PASS dev runner started server and web (${webUrl})`);
  console.log(`PASS test database is isolated at ${dbPath}`);

  const apiGet = async (pathname) => {
    const response = await fetch(`${serverOrigin}${pathname}`, {
      headers: { accept: 'application/json', 'x-devpilot-token': token },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error?.message ?? `API request failed with ${response.status}`);
    }
    return body;
  };
  const waitForSession = (sessionId, predicate, message) =>
    waitUntil(async () => {
      const result = await apiGet('/api/sessions');
      const session = result.sessions.find((item) => item.id === sessionId);
      return Boolean(session && predicate(session));
    }, message);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  const socketUrls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('websocket', (socket) => socketUrls.push(socket.url()));
  const terminalText = async (terminalId) =>
    (await page.getByTestId(`terminal-screen-${terminalId}`).locator('.xterm-rows').textContent()) ?? '';
  const waitForTerminalText = (terminalId, expected, timeout = 20000) =>
    page.waitForFunction(
      ({ id, text }) =>
        document
          .querySelector(`[data-testid="terminal-screen-${id}"] .xterm-rows`)
          ?.textContent?.includes(text),
      { id: terminalId, text: expected },
      { timeout },
    );
  const focusTerminal = async (terminalId) => {
    await page.getByTestId(`terminal-screen-${terminalId}`).click({ position: { x: 80, y: 60 } });
  };
  const parseDimensions = (value) => {
    const match = value?.match(/(\d+)x(\d+)/);
    return match ? { cols: Number(match[1]), rows: Number(match[2]) } : null;
  };

  await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="health-status"]')?.textContent?.includes('Backend online'),
    null,
    { timeout: 20000 },
  );
  console.log('PASS backend health is visible in the UI');

  const projects = await page.textContent('[data-testid="stat-projects"]');
  const tools = await page.textContent('[data-testid="stat-tools"]');
  const terminals = await page.textContent('[data-testid="stat-terminals"]');
  assert(projects?.trim() === '0', `Expected 0 projects, got ${projects}`);
  assert(tools?.trim() === '1', `Expected 1 enabled CLI profile, got ${tools}`);
  assert(terminals?.trim() === '0', `Expected 0 running terminals, got ${terminals}`);
  console.log('PASS overview shows real API counts (0 projects, 1 enabled profile, 0 terminals)');

  const routes = [
    ['Overview', '/', 'Overview'],
    ['Sessions', '/sessions', 'Sessions'],
    ['Projects', '/projects', 'Projects'],
    ['Terminals', '/terminals', 'Terminals'],
    ['CLI Tools', '/tools', 'CLI Tools'],
    ['Settings', '/settings', 'Settings'],
  ];

  for (const [label, pathname, heading] of routes) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.waitForURL((url) => url.pathname === pathname, { timeout: 10000 });
    await page
      .getByRole('heading', { name: heading, exact: true, level: 1 })
      .waitFor({ state: 'visible', timeout: 10000 });
    const title = (await page.textContent('h1'))?.trim();
    assert(title === heading, `Expected heading ${heading} on ${pathname}, got ${title}`);
    console.log(`PASS route ${pathname} rendered "${heading}"`);
  }

  const toolDb = new Database(dbPath);
  toolDb
    .prepare(
      `INSERT INTO tool_profiles (
         id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
         launch_verified, last_status, last_checked_at, notes
       ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
    )
    .run(
      'e2e-test',
      'E2E Test CLI',
      process.execPath,
      JSON.stringify([fixtureScript, fixtureEvidence]),
      new Date().toISOString(),
      'Test-only child process injected into the isolated browser database.',
    );
  toolDb
    .prepare(
      `INSERT INTO tool_profiles (
         id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
         launch_verified, last_status, last_checked_at, notes
       ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
    )
    .run(
      'e2e-test-2',
      'E2E Test CLI Two',
      process.execPath,
      JSON.stringify([fixtureScript, secondFixtureEvidence]),
      new Date().toISOString(),
      'Second test-only child process for terminal isolation checks.',
    );
  for (const [id, name] of [
    ['e2e-test-3', 'E2E Test CLI Three'],
    ['e2e-test-4', 'E2E Test CLI Four'],
  ]) {
    toolDb
      .prepare(
        `INSERT INTO tool_profiles (
           id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
           launch_verified, last_status, last_checked_at, notes
         ) VALUES (?, ?, ?, ?, 1, 0, 1, 'available', ?, ?)`,
      )
      .run(
        id,
        name,
        process.execPath,
        JSON.stringify([fixtureScript, fixtureEvidence]),
        new Date().toISOString(),
        'Test-only profile used to verify the per-session selection limit.',
      );
  }
  toolDb.close();
  console.log('PASS test-only process profiles inserted into the isolated database');

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  const sessionDialog = page.locator('[data-testid="new-session-dialog"]');
  await sessionDialog.waitFor({ state: 'visible' });
  assert(
    await page.locator('[data-testid="project-select"]').isDisabled(),
    'Project select should be disabled while no projects exist',
  );
  assert(
    await page.locator('[data-testid="start-session"]').isDisabled(),
    'Start session should stay disabled while no project exists',
  );
  console.log('PASS New Session dialog keeps launch disabled before any project exists');
  await page.keyboard.press('Escape');
  await sessionDialog.waitFor({ state: 'hidden' });

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByText('No projects registered', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Add project', exact: true }).click();

  const addDialog = page.locator('[data-testid="add-project-dialog"]');
  await addDialog.waitFor({ state: 'visible' });
  await page.getByTestId('project-path').fill(projectDir);
  await page.getByTestId('project-name-input').fill('E2E Café Project');
  await page.getByTestId('create-project').click();
  await addDialog.waitFor({ state: 'hidden' });

  await page.getByRole('heading', { name: 'E2E Café Project', exact: true }).waitFor();
  assert(
    (await page.getByTestId('project-path-status').textContent())?.includes('Path OK'),
    'Project path status is not OK',
  );
  assert(
    (await page.getByText('0 sessions', { exact: true }).count()) === 1,
    'Project should show its real zero session count',
  );
  assert(
    (await page.getByText('Never used', { exact: true }).count()) === 1,
    'Project should show "Never used" when lastUsedAt is null',
  );
  console.log('PASS manual folder path registered with Unicode/space support and live status');

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="stat-projects"]')?.textContent?.trim() === '1',
    null,
    { timeout: 10000 },
  );
  console.log('PASS overview project count updated from the database');

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByTestId('project-search').fill('Café E2E');
  await page.getByRole('heading', { name: 'E2E Café Project', exact: true }).waitFor();
  await page.getByTestId('project-search').fill('no-such-project');
  await page.getByText(/No projects match/).waitFor();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('heading', { name: 'E2E Café Project', exact: true }).waitFor();
  console.log('PASS project search and no-results state');

  await page.getByRole('button', { name: 'Rename E2E Café Project', exact: true }).click();
  const editDialog = page.locator('[data-testid="edit-project-dialog"]');
  await editDialog.waitFor({ state: 'visible' });
  await page.getByTestId('edit-project-name').fill('Renamed Café Project');
  await page.getByTestId('save-project-name').click();
  await editDialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Renamed Café Project', exact: true }).waitFor();
  console.log('PASS project display name updated through the API');

  await page.getByRole('button', { name: 'New session', exact: true }).click();
  await sessionDialog.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => {
      const select = document.querySelector('[data-testid="project-select"]');
      return select instanceof HTMLSelectElement && !select.disabled && select.value !== '';
    },
    null,
    { timeout: 10000 },
  );
  const optionText = await page.locator('[data-testid="project-select"] option:checked').textContent();
  assert(optionText?.includes('Renamed Café Project'), 'Registered project is missing from the dialog');
  const startTitle = await page.locator('[data-testid="start-session"]').getAttribute('title');
  assert(startTitle, 'Start session has no readiness explanation');
  console.log('PASS New Session dialog lists the registered project with a real readiness reason');
  await page.keyboard.press('Escape');
  await sessionDialog.waitFor({ state: 'hidden' });

  await page.getByRole('link', { name: 'CLI Tools', exact: true }).click();
  const antigravity = page.locator('[data-testid="tool-antigravity"]');
  await antigravity.waitFor({ state: 'visible', timeout: 10000 });
  assert(await antigravity.isVisible(), 'Antigravity profile card is missing');
  assert((await antigravity.textContent())?.includes('Unverified'), 'Antigravity is not marked unverified');
  assert((await antigravity.textContent())?.includes('Not configured'), 'Antigravity shows an invented command');

  await page.getByTestId('check-tool-opencode').click();
  await page.getByText(/OpenCode CLI: unknown/).waitFor();
  await page.getByTestId('check-tool-antigravity').click();
  await page.getByText(/Antigravity: unconfigured/).waitFor();
  console.log('PASS CLI checks persist honest unknown/unconfigured states without launching agents');

  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  assert(
    (await page.getByText('Open Terminal', { exact: true }).count()) === 0,
    'A dead Open Terminal button is visible',
  );
  await page.getByTestId('new-session-button').click();
  await sessionDialog.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => {
      const select = document.querySelector('[data-testid="project-select"]');
      return select instanceof HTMLSelectElement && !select.disabled && select.value !== '';
    },
    null,
    { timeout: 10000 },
  );
  await page.getByRole('radio', { name: /Custom session/ }).check({ force: true });
  await sessionDialog.getByText('0 of 3 selected', { exact: true }).waitFor({ timeout: 10000 });
  assert(
    (await sessionDialog.textContent())?.includes('Select up to 3 profiles'),
    'Session dialog did not use the server-provided terminal limit',
  );
  const e2eCheckbox = page.getByTestId('tool-checkbox-e2e-test');
  const secondE2eCheckbox = page.getByTestId('tool-checkbox-e2e-test-2');
  const thirdE2eCheckbox = page.getByTestId('tool-checkbox-e2e-test-3');
  const fourthE2eCheckbox = page.getByTestId('tool-checkbox-e2e-test-4');
  await e2eCheckbox.waitFor({ state: 'visible' });
  await secondE2eCheckbox.waitFor({ state: 'visible' });
  await thirdE2eCheckbox.waitFor({ state: 'visible' });
  await fourthE2eCheckbox.waitFor({ state: 'visible' });
  assert(!(await e2eCheckbox.isDisabled()), 'Injected launch-ready profile is disabled');
  assert(
    !(await secondE2eCheckbox.isDisabled()),
    'Second injected launch-ready profile is disabled',
  );
  assert(
    !(await thirdE2eCheckbox.isDisabled()),
    'Third injected launch-ready profile is disabled before the limit is reached',
  );
  assert(
    await page.getByTestId('tool-checkbox-opencode').isDisabled(),
    'OpenCode should remain disabled in Custom session',
  );
  assert(
    (await sessionDialog.textContent())?.includes('Disabled in the CLI registry.'),
    'Disabled profile reason is missing from the dialog',
  );
  await e2eCheckbox.check();
  await secondE2eCheckbox.check();
  await sessionDialog.getByText('2 of 3 selected', { exact: true }).waitFor({ timeout: 10000 });
  assert(
    !(await thirdE2eCheckbox.isDisabled()),
    'Third profile should stay selectable while two of three are selected',
  );
  await thirdE2eCheckbox.check();
  await sessionDialog.getByText('3 of 3 selected', { exact: true }).waitFor({ timeout: 10000 });
  assert(
    await fourthE2eCheckbox.isDisabled(),
    'A fourth profile should be disabled once the per-session limit is reached',
  );
  await thirdE2eCheckbox.uncheck();
  await sessionDialog.getByText('2 of 3 selected', { exact: true }).waitFor({ timeout: 10000 });
  assert(
    !(await fourthE2eCheckbox.isDisabled()),
    'The extra profile should become selectable again after freeing a slot',
  );
  assert(
    !(await page.getByTestId('start-session').isDisabled()),
    'Start session should enable after selecting launch-ready profiles',
  );
  await page.getByTestId('start-session').click();
  await sessionDialog.waitFor({ state: 'hidden' });
  await page.waitForURL((url) => url.pathname === '/sessions', { timeout: 10000 });

  let session = null;
  await waitUntil(async () => {
    const result = await apiGet('/api/sessions');
    session = result.sessions[0] ?? null;
    return Boolean(session);
  }, 'Created session was not saved');
  await waitForSession(
    session.id,
    (item) =>
      item.terminals.length === 2 &&
      item.terminals.every((terminal) => terminal.status === 'running'),
    'Session did not reach running with both terminals',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  let terminalA = session.terminals.find((entry) => entry.toolProfileId === 'e2e-test');
  let terminalB = session.terminals.find((entry) => entry.toolProfileId === 'e2e-test-2');
  assert(terminalA && terminalB, 'Both test terminals are missing from the saved session');
  const firstPidA = terminalA.pid;
  const firstPidB = terminalB.pid;
  assert(
    isAlive(firstPidA) && isAlive(firstPidB),
    `Running terminal pids are not alive: A=${terminalA.status}/${firstPidA}/${isAlive(firstPidA)}, B=${terminalB.status}/${firstPidB}/${isAlive(firstPidB)}, errors=${terminalA.lastError ?? ''}|${terminalB.lastError ?? ''}`,
  );
  await page.getByTestId(`session-card-${session.id}`).waitFor();
  const sessionCardText = await page.getByTestId(`session-card-${session.id}`).textContent();
  assert(sessionCardText.includes('Running'), 'Session running state is missing');
  assert(
    sessionCardText.includes('Open workspace'),
    'Open workspace action is missing from the session card',
  );
  assert(
    (await page.getByText('Open Terminal', { exact: true }).count()) === 0,
    'A dead Open Terminal button is visible after session creation',
  );
  await waitUntil(
    () => fs.existsSync(fixtureEvidence) && fs.existsSync(secondFixtureEvidence),
    'Terminal cwd evidence is missing',
  );
  const terminalEvidence = JSON.parse(fs.readFileSync(fixtureEvidence, 'utf8'));
  const secondTerminalEvidence = JSON.parse(fs.readFileSync(secondFixtureEvidence, 'utf8'));
  assert(
    path.resolve(terminalEvidence.cwd) === fs.realpathSync.native(projectDir) &&
      path.resolve(secondTerminalEvidence.cwd) === fs.realpathSync.native(projectDir),
    'A terminal launched in the wrong cwd',
  );
  assert(terminalEvidence.pid === firstPidA, 'Terminal A evidence pid does not match the API pid');
  assert(
    secondTerminalEvidence.pid === firstPidB,
    'Terminal B evidence pid does not match the API pid',
  );
  console.log('PASS real Custom session launched two terminals in the project cwd');

  await page.getByTestId(`open-workspace-${session.id}`).click();
  await page.waitForURL(
    (url) => url.pathname === '/terminals' && url.searchParams.get('session') === session.id,
    { timeout: 10000 },
  );
  await page.getByTestId(`terminal-panel-${terminalA.id}`).waitFor({ state: 'visible' });
  await page.getByTestId(`terminal-panel-${terminalB.id}`).waitFor({ state: 'visible' });
  await waitForTerminalText(terminalA.id, 'E2E_READY');
  await waitForTerminalText(terminalB.id, 'E2E_READY');
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-connection-${terminalA.id}`).textContent())?.includes(
        'Live',
      ) &&
      (await page.getByTestId(`terminal-connection-${terminalB.id}`).textContent())?.includes(
        'Live',
      ),
    'Terminal WebSocket connections did not become live',
  );
  assert(socketUrls.length > 0, 'The browser did not open a terminal WebSocket');
  assert(
    socketUrls.every((url) => !url.includes(token)),
    'The local token was exposed in a terminal WebSocket URL',
  );
  console.log('PASS terminal workspace connected both xterm panels over WebSockets');

  await focusTerminal(terminalA.id);
  await page.keyboard.type('hello-alpha');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalA.id, 'E2E_ECHO:hello-alpha');
  assert(
    !(await terminalText(terminalB.id)).includes('E2E_ECHO:hello-alpha'),
    'Terminal input leaked into the second terminal',
  );

  await focusTerminal(terminalB.id);
  await page.keyboard.type('hello-beta');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalB.id, 'E2E_ECHO:hello-beta');
  assert(
    !(await terminalText(terminalA.id)).includes('E2E_ECHO:hello-beta'),
    'Terminal output leaked into the first terminal',
  );
  console.log('PASS typed input reached the correct real process and stayed isolated per terminal');

  const dimensionsBefore = parseDimensions(
    await page.getByTestId(`terminal-dimensions-${terminalA.id}`).textContent(),
  );
  assert(dimensionsBefore, 'Terminal dimensions were not reported');
  await page.getByTestId(`maximize-terminal-${terminalA.id}`).click();
  await waitUntil(async () => {
    const current = parseDimensions(
      await page.getByTestId(`terminal-dimensions-${terminalA.id}`).textContent(),
    );
    return Boolean(current && current.cols > dimensionsBefore.cols);
  }, 'Maximizing the terminal did not resize the xterm workspace');
  await waitUntil(async () => {
    const panel = page.getByTestId(`terminal-panel-${terminalA.id}`);
    const ptySize = await panel.getAttribute('data-pty-size');
    const current = parseDimensions(
      await page.getByTestId(`terminal-dimensions-${terminalA.id}`).textContent(),
    );
    return Boolean(current && ptySize === `${current.cols}x${current.rows}`);
  }, 'The server did not acknowledge the resized PTY dimensions');
  await page.getByTestId(`maximize-terminal-${terminalA.id}`).click();
  console.log('PASS maximize sent the xterm resize over WebSocket and the PTY acknowledged it');

  await page.getByTestId(`maximize-terminal-${terminalA.id}`).click();
  await page.getByTestId('terminal-layout-select').selectOption('single');
  await waitUntil(async () => {
    const preferences = (await apiGet('/api/settings/workspace')).preferences;
    return (
      preferences.selectedSessionId === session.id &&
      preferences.maximizedTerminalId === terminalA.id &&
      preferences.terminalLayout === 'single'
    );
  }, 'Workspace preferences were not persisted');
  const preferencePid = terminalA.pid;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForURL(
    (url) => url.pathname === '/terminals' && url.searchParams.get('session') === session.id,
    { timeout: 10000 },
  );
  await page.getByTestId(`terminal-panel-${terminalA.id}`).waitFor({ state: 'visible' });
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-panel-${terminalA.id}`).getAttribute('class'))?.includes(
        'terminal-panel-maximized',
      ) ?? false,
    'Restored workspace did not re-maximize the saved terminal',
  );
  assert(
    (await page.getByTestId('terminal-layout-select').inputValue()) === 'single',
    'Restored workspace did not apply the saved terminal layout',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalA = session.terminals.find((entry) => entry.id === terminalA.id);
  assert(terminalA.pid === preferencePid, 'Reloading workspace preferences replaced the process');
  await page.getByTestId(`maximize-terminal-${terminalA.id}`).click();
  await page.getByTestId('terminal-layout-select').selectOption('auto');
  await waitUntil(async () => {
    const preferences = (await apiGet('/api/settings/workspace')).preferences;
    return preferences.maximizedTerminalId === null && preferences.terminalLayout === 'auto';
  }, 'Workspace preference reset was not persisted');
  console.log('PASS selected session, terminal layout, and maximized panel survived a reload');

  await focusTerminal(terminalA.id);
  await page.keyboard.type('large');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalA.id, 'E2E_LARGE_END', 30000);
  console.log('PASS large terminal output traversed the WebSocket without breaking the UI');

  const pidBeforeReload = terminalA.pid;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(`terminal-panel-${terminalA.id}`).waitFor({ state: 'visible' });
  await waitForTerminalText(terminalA.id, 'E2E_LARGE_END', 30000);
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-connection-${terminalA.id}`).textContent())?.includes(
        'Live',
      ),
    'Reloaded terminal did not reconnect',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalA = session.terminals.find((entry) => entry.id === terminalA.id);
  assert(terminalA.pid === pidBeforeReload, 'Reloading the UI replaced the terminal process');
  assert(isAlive(pidBeforeReload), 'Terminal process died during UI reconnect');
  await focusTerminal(terminalA.id);
  await page.keyboard.type('reconnect-marker');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalA.id, 'E2E_ECHO:reconnect-marker');
  const reconnectText = await terminalText(terminalA.id);
  assert(
    countOccurrences(reconnectText, 'E2E_ECHO:reconnect-marker') === 1,
    'Reloading the UI duplicated live terminal output',
  );
  console.log('PASS browser reload reattached to the same live process without duplication');

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10000 });
  await page.getByRole('link', { name: 'Terminals', exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === '/terminals' && url.searchParams.get('session') === session.id,
    { timeout: 10000 },
  );
  await page.getByTestId(`terminal-panel-${terminalA.id}`).waitFor({ state: 'visible' });
  await waitForTerminalText(terminalA.id, 'E2E_LARGE_END', 30000);
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-connection-${terminalA.id}`).textContent())?.includes(
        'Live',
      ),
    'Terminal did not reconnect after the panel was unmounted',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalA = session.terminals.find((entry) => entry.id === terminalA.id);
  assert(terminalA.pid === pidBeforeReload, 'Unmounting the terminal replaced its process');
  assert(isAlive(pidBeforeReload), 'Terminal process died while its panel was unmounted');
  console.log('PASS panel unmount reattached without replacing the managed process');

  await focusTerminal(terminalB.id);
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await waitForSession(
    session.id,
    (item) =>
      item.terminals.find((entry) => entry.id === terminalB.id)?.status === 'exited',
    'Exited terminal did not settle to exited',
  );
  await waitUntil(() => !isAlive(terminalB.pid), 'Exited terminal process survived');
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-status-${terminalB.id}`).textContent())?.includes(
        'Exited',
      ),
    'Terminal panel did not show the exited state',
  );
  console.log('PASS terminal exit updated the real process state in the workspace');

  await page.getByTestId(`restart-terminal-${terminalB.id}`).click();
  await waitForSession(
    session.id,
    (item) =>
      item.terminals.find((entry) => entry.id === terminalB.id)?.status === 'running',
    'Restarted terminal B did not reach running',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalB = session.terminals.find((entry) => entry.id === terminalB.id);
  assert(terminalB.pid !== firstPidB && isAlive(terminalB.pid), 'Terminal B restart failed');
  await focusTerminal(terminalB.id);
  await page.keyboard.type('after-restart');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalB.id, 'E2E_ECHO:after-restart');
  console.log('PASS restart reconnected the panel to a new live terminal handle');

  await page.getByTestId(`stop-terminal-${terminalA.id}`).click();
  await waitForSession(
    session.id,
    (item) =>
      item.terminals.find((entry) => entry.id === terminalA.id)?.status === 'stopped',
    'Stopped terminal A did not settle to stopped',
  );
  await waitUntil(() => !isAlive(terminalA.pid), 'Stopped terminal A process survived');
  await waitUntil(
    async () =>
      (await page.getByTestId(`terminal-status-${terminalA.id}`).textContent())?.includes(
        'Stopped',
      ),
    'Terminal panel did not show the stopped state',
  );

  await page.getByTestId(`restart-terminal-${terminalA.id}`).click();
  await waitForSession(
    session.id,
    (item) =>
      item.terminals.find((entry) => entry.id === terminalA.id)?.status === 'running',
    'Restarted terminal A did not reach running',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalA = session.terminals.find((entry) => entry.id === terminalA.id);
  assert(terminalA.pid !== firstPidA && isAlive(terminalA.pid), 'Terminal A restart failed');
  await focusTerminal(terminalA.id);
  await page.keyboard.type('after-restart-a');
  await page.keyboard.press('Enter');
  await waitForTerminalText(terminalA.id, 'E2E_ECHO:after-restart-a');
  console.log('PASS workspace stop and restart controls stayed bound to the owned processes');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('stop-session-workspace').click();
  await waitForSession(
    session.id,
    (item) =>
      item.status === 'stopped' &&
      item.terminals.every((entry) => entry.status === 'stopped'),
    'Workspace Stop session did not settle to stopped',
  );
  await waitUntil(
    () => !isAlive(terminalA.pid) && !isAlive(terminalB.pid),
    'A session process survived workspace stop',
  );
  console.log('PASS workspace Stop session stopped every owned terminal');

  await page.getByRole('link', { name: 'Sessions', exact: true }).click();
  await page.getByTestId(`session-card-${session.id}`).waitFor();
  await page.getByTestId(`restart-terminal-${terminalA.id}`).click();
  await waitForSession(
    session.id,
    (item) => item.status === 'running',
    'Restarted terminal did not reach running',
  );
  session = (await apiGet('/api/sessions')).sessions.find((item) => item.id === session.id);
  terminalA = session.terminals.find((entry) => entry.id === terminalA.id);
  assert(terminalA.pid !== firstPidA, 'Restart reused the old terminal pid');
  assert(isAlive(terminalA.pid), 'Restarted terminal pid is not alive');
  assert(terminalA.restartCount >= 2, 'Restart count was not persisted');
  console.log('PASS Restart created a new live terminal handle');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByTestId(`stop-session-${session.id}`).click();
  await waitForSession(
    session.id,
    (item) => item.status === 'stopped' && item.terminals.every((entry) => entry.status === 'stopped'),
    'Stop session did not settle to stopped',
  );
  await waitUntil(() => !isAlive(terminalA.pid), 'Session terminal process survived');
  console.log('PASS confirmed Stop session stopped every terminal and kept the saved record');

  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Renamed Café Project', exact: true }).click();
  const deleteDialog = page.locator('[data-testid="delete-project-dialog"]');
  await deleteDialog.waitFor({ state: 'visible' });
  assert(
    (await deleteDialog.textContent())?.includes('Removes from DevPilot only; files are untouched.'),
    'Delete confirmation is missing the required wording',
  );
  await page.getByTestId('confirm-delete-project').click();
  const deleteAlert = deleteDialog.getByRole('alert');
  await deleteAlert.waitFor({ state: 'visible' });
  assert(
    (await deleteAlert.textContent())?.includes('saved sessions'),
    'Project delete refusal did not explain the saved session dependency',
  );
  assert(await deleteDialog.isVisible(), 'Project delete dialog closed after refusal');
  console.log('PASS project delete refusal is visible while a session record exists');
  await deleteDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await deleteDialog.waitFor({ state: 'hidden' });

  const cleanupDb = new Database(dbPath);
  cleanupDb.prepare('DELETE FROM session_terminals').run();
  cleanupDb.prepare('DELETE FROM sessions').run();
  cleanupDb.close();

  await page.getByRole('button', { name: 'Remove Renamed Café Project', exact: true }).click();
  await deleteDialog.waitFor({ state: 'visible' });
  await page.getByTestId('confirm-delete-project').click();
  await deleteDialog.waitFor({ state: 'hidden' });
  await page.getByText('No projects registered', { exact: true }).waitFor();

  assert(fs.existsSync(projectDir), 'Project folder was deleted');
  assert(fs.readFileSync(sentinelFile, 'utf8') === 'keep this file', 'Sentinel file was modified');
  console.log('PASS project removal left the folder and sentinel file untouched');

  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="stat-projects"]')?.textContent?.trim() === '0',
    null,
    { timeout: 10000 },
  );
  console.log('PASS overview project count returned to zero after removal');

  assert(pageErrors.length === 0, `Browser page errors: ${pageErrors.join('; ')}`);
  await page.close();
  await wait(500);
  assert(
    !output.includes('ECONNABORTED'),
    'Expected browser disconnects logged as Vite proxy errors',
  );
  console.log('PASS expected browser disconnects stayed out of the proxy error log');
  console.log('PASS no browser page errors during the smoke test');
  console.log('\nP3 browser smoke test passed.');
} catch (error) {
  console.error(`\nFAIL: ${error.message}`);
  const tail = output.trim().slice(-2000);
  if (tail) console.error(`Dev output tail:\n${tail}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  killTree(dev.pid);
  await wait(800);
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Windows may briefly retain a handle; the OS temp folder remains harmless.
  }
}
