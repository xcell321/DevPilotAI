const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const POC_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(POC_ROOT, '..', '..');
const TIMEOUT = 20000;

function stripAnsi(value) {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][^\x1b]*(?:\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(check, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      let value = false;
      try {
        value = check();
      } catch (error) {
        clearInterval(timer);
        reject(error);
        return;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    }, 100);
  });
}

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: POC_ROOT,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data.toString(); });
  child.stderr.on('data', (data) => { output += data.toString(); });
  child.on('exit', (code) => {
    if (code !== 0) output += `\n[server exited with ${code}]`;
  });
  const match = await waitUntil(
    () => output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/),
    15000,
    'the local server to start',
  );
  return {
    child,
    port: Number(match[1]),
    token: match[2],
    logs: () => output,
  };
}

async function api(server, pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-devpilot-token': server.token,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function connectTerminal(server, terminalId, origin) {
  const url = `ws://127.0.0.1:${server.port}/ws/terminals/${terminalId}?token=${server.token}`;
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  const state = { socket, output: '', messages: [], opened: false, closed: false, error: null };
  socket.on('open', () => { state.opened = true; });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    state.messages.push(message);
    if (message.type === 'output') state.output += message.data;
  });
  socket.on('error', (error) => { state.error = error; });
  socket.on('close', () => { state.closed = true; });
  return state;
}

function expectRejected(server, terminalId, { token, origin }) {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${server.port}/ws/terminals/${terminalId}?token=${token}`;
    const socket = new WebSocket(url, origin ? { origin } : undefined);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket was not rejected in time'));
    }, 5000);
    socket.on('open', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('WebSocket connection was accepted when it should be rejected'));
    });
    socket.on('error', () => { clearTimeout(timer); resolve(); });
    socket.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function testClaudeInteractive(server) {
  const created = await api(server, '/api/terminals', {
    method: 'POST',
    body: JSON.stringify({ toolId: 'claude', cwd: PROJECT_ROOT, cols: 100, rows: 28 }),
  });
  assert(created.status === 201, `Claude terminal creation returned ${created.status}`);
  const terminalId = created.body.id;
  console.log(`PASS launched Claude Code CLI (pid ${created.body.pid}) in ${created.body.cwd}`);

  const origin = `http://127.0.0.1:${server.port}`;
  await expectRejected(server, terminalId, { token: 'wrong-token', origin });
  console.log('PASS WebSocket rejected an invalid local token');
  await expectRejected(server, terminalId, { token: server.token, origin: 'http://malicious.example' });
  console.log('PASS WebSocket rejected a foreign origin');

  const session = connectTerminal(server, terminalId, origin);
  await waitUntil(() => session.opened, 5000, 'the terminal WebSocket to open');

  const trusted = await waitUntil(
    () => /trust this folder/i.test(stripAnsi(session.output)),
    4000,
    'the trust prompt (already trusted on this machine)',
  ).then(() => true).catch(() => false);
  if (trusted) {
    session.socket.send(JSON.stringify({ type: 'input', data: '\x1b[B\r' }));
    console.log('PASS accepted the Claude Code trust prompt through PTY input');
  }

  const beforeInput = session.output.length;
  await waitUntil(
    () => /accept edits|Try "/.test(stripAnsi(session.output)),
    TIMEOUT,
    'the Claude Code prompt',
  );
  assert(session.output.length > 0, 'Claude Code produced no terminal output');

  session.socket.send(JSON.stringify({ type: 'input', data: '/status\r' }));
  await waitUntil(
    () => /Version:/.test(stripAnsi(session.output)) && /Session ID:/.test(stripAnsi(session.output)),
    15000,
    'the /status panel rendered by Claude Code',
  );
  assert(session.output.length > beforeInput, 'Claude Code output did not change after input');
  console.log('PASS interactive input reached Claude Code and it rendered the /status panel');

  session.socket.send(JSON.stringify({ type: 'resize', cols: 92, rows: 24 }));
  await wait(500);
  const resized = await api(server, `/api/terminals/${terminalId}`);
  assert(
    resized.body.cols === 92 && resized.body.rows === 24,
    `Terminal size is ${resized.body.cols}x${resized.body.rows} after resize`,
  );
  console.log('PASS terminal resize reached the PTY (92x24)');

  session.socket.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  await wait(400);
  session.socket.send(JSON.stringify({ type: 'input', data: '/exit\r' }));
  const exitMessage = await waitUntil(
    () => session.messages.find((message) => message.type === 'exit'),
    15000,
    'Claude Code to exit',
  );
  assert(exitMessage.exitCode === 0, `Claude Code exited with code ${exitMessage.exitCode}`);
  console.log('PASS /exit terminated Claude Code cleanly with exit code 0');
  session.socket.close();
}

async function testStopEndpoint(server) {
  const created = await api(server, '/api/terminals', {
    method: 'POST',
    body: JSON.stringify({ toolId: 'opencode', cwd: PROJECT_ROOT, cols: 100, rows: 28 }),
  });
  assert(created.status === 201, `OpenCode terminal creation returned ${created.status}`);
  const terminalId = created.body.id;
  const session = connectTerminal(server, terminalId, `http://127.0.0.1:${server.port}`);
  await waitUntil(() => session.opened, 5000, 'the OpenCode WebSocket to open');
  await waitUntil(() => session.output.length > 100, 15000, 'OpenCode terminal output');
  console.log(`PASS launched OpenCode CLI (pid ${created.body.pid}) and received PTY output`);

  const stopped = await api(server, `/api/terminals/${terminalId}/stop`, { method: 'POST' });
  assert(stopped.status === 200, `Stop endpoint returned ${stopped.status}`);
  await waitUntil(
    () => session.messages.find((message) => message.type === 'exit'),
    15000,
    'the OpenCode process to stop',
  );
  const detail = await api(server, `/api/terminals/${terminalId}`);
  assert(detail.body.status === 'exited', `Terminal status is ${detail.body.status} after stop`);
  console.log('PASS stop endpoint terminated the tracked process and reported exited');
  session.socket.close();
}

(async () => {
  const server = await startServer();
  try {
    const health = await api(server, '/api/health');
    assert(health.status === 200 && health.body.ok, 'Health endpoint failed');
    assert(health.body.nodePty, 'node-pty version missing from health response');
    console.log(`PASS backend health (node ${health.body.node}, node-pty ${health.body.nodePty}, ${health.body.platform})`);

    const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    assert(unauthenticated.status === 401, `Unauthenticated request returned ${unauthenticated.status}`);
    console.log('PASS REST API rejected a request without the local token');

    const statuses = Object.fromEntries(health.body.tools.map((tool) => [tool.id, tool.status]));
    assert(statuses.claude === 'available', `Claude status is ${statuses.claude}`);
    assert(statuses.opencode === 'available', `OpenCode status is ${statuses.opencode}`);
    assert(statuses.freebuff === 'available', `Freebuff status is ${statuses.freebuff}`);
    assert(statuses.antigravity === 'unverified', `Antigravity status is ${statuses.antigravity}`);
    console.log(`PASS tool registry: claude=${statuses.claude}, opencode=${statuses.opencode}, freebuff=${statuses.freebuff}, antigravity=${statuses.antigravity}`);

    await testClaudeInteractive(server);
    await testStopEndpoint(server);

    console.log('\nAll P0 headless checks passed.');
  } catch (error) {
    console.error(`\nFAIL: ${error.message}`);
    const logs = stripAnsi(server.logs()).trim();
    if (logs) console.error(`Server log tail:\n${logs.slice(-1500)}`);
    process.exitCode = 1;
  } finally {
    server.child.kill();
  }
})();
