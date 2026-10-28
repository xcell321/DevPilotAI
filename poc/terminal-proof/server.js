const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 0);
const TOKEN = crypto.randomBytes(24).toString('hex');
const CWD_ROOT = __dirname;
const MAX_INPUT_BYTES = 64 * 1024;
const OUTPUT_BUFFER_LIMIT = 512 * 1024;

const npmGlobalModules = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
const userProfile = process.env.USERPROFILE || '';

const TOOL_DEFINITIONS = [
  {
    id: 'claude',
    displayName: 'Claude Code CLI',
    command: path.join(npmGlobalModules, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    args: [],
    versionArgs: ['--version'],
  },
  {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    command: path.join(npmGlobalModules, 'opencode-ai', 'bin', 'opencode.exe'),
    args: [],
    versionArgs: ['--version'],
  },
  {
    id: 'freebuff',
    displayName: 'Freebuff CLI',
    command: path.join(userProfile, '.config', 'manicode', 'freebuff.exe'),
    args: [],
    versionArgs: ['--version'],
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    command: null,
    args: [],
    versionArgs: null,
    note: 'Executable and launch syntax not verified on this machine. Configure manually; it is not launchable in P0.',
  },
];

const tools = new Map();
for (const definition of TOOL_DEFINITIONS) {
  const installed = Boolean(definition.command) && fs.existsSync(definition.command);
  tools.set(definition.id, {
    ...definition,
    status: definition.command ? (installed ? 'available' : 'missing') : 'unverified',
    launchable: Boolean(definition.command) && installed,
  });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const terminals = new Map();
let actualPort = null;

function allowedOrigins() {
  return new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
}

function originAllowed(origin) {
  if (!origin) return true;
  return allowedOrigins().has(origin);
}

function requireToken(req, res, next) {
  if (req.get('x-devpilot-token') !== TOKEN) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid local session token.' } });
  }
  if (!originAllowed(req.get('origin'))) {
    return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Origin is not allowed.' } });
  }
  next();
}

function toolSummary() {
  return [...tools.values()].map((tool) => ({
    id: tool.id,
    displayName: tool.displayName,
    status: tool.status,
    launchable: tool.launchable,
    note: tool.note || null,
  }));
}

function resolveCwd(input) {
  const candidate = typeof input === 'string' && input.trim() ? input.trim() : CWD_ROOT;
  const resolved = path.resolve(candidate);
  const stats = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stats || !stats.isDirectory()) {
    const error = new Error('Working directory does not exist or is not a directory.');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

app.get('/api/health', requireToken, (req, res) => {
  res.json({
    ok: true,
    backend: 'devpilot-terminal-proof',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    nodePty: require('node-pty/package.json').version,
    tools: toolSummary(),
  });
});

app.post('/api/terminals', requireToken, (req, res) => {
  try {
    const toolId = String(req.body?.toolId || '');
    const tool = tools.get(toolId);
    if (!tool) {
      return res.status(400).json({ error: { code: 'unknown_tool', message: 'Unknown tool profile.' } });
    }
    if (!tool.launchable) {
      return res.status(409).json({
        error: { code: 'tool_unavailable', message: `${tool.displayName} is not verified or not installed.` },
      });
    }

    const cwd = resolveCwd(req.body?.cwd);
    const cols = clampInteger(req.body?.cols, 2, 500, 120);
    const rows = clampInteger(req.body?.rows, 1, 200, 30);

    const child = pty.spawn(tool.command, tool.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    const terminal = {
      id: crypto.randomUUID(),
      toolId,
      cwd,
      cols,
      rows,
      child,
      status: 'running',
      exitCode: null,
      signal: null,
      buffer: '',
      sockets: new Set(),
      createdAt: new Date().toISOString(),
    };
    terminals.set(terminal.id, terminal);

    child.onData((data) => {
      terminal.buffer += data;
      if (terminal.buffer.length > OUTPUT_BUFFER_LIMIT) {
        terminal.buffer = terminal.buffer.slice(-OUTPUT_BUFFER_LIMIT);
      }
      for (const socket of terminal.sockets) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'output', data }));
        }
      }
    });

    child.onExit(({ exitCode, signal }) => {
      terminal.status = 'exited';
      terminal.exitCode = exitCode;
      terminal.signal = signal || null;
      for (const socket of terminal.sockets) {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'exit', exitCode, signal: terminal.signal }));
          socket.close();
        }
      }
    });

    res.status(201).json({
      id: terminal.id,
      pid: child.pid,
      toolId,
      cwd,
      cols,
      rows,
      status: terminal.status,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: { code: error.statusCode ? 'invalid_directory' : 'spawn_failed', message: error.message },
    });
  }
});

app.post('/api/terminals/:id/stop', requireToken, (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Terminal not found.' } });
  }
  if (terminal.status === 'running') {
    terminal.child.kill();
  }
  res.json({ id: terminal.id, status: terminal.status });
});

app.get('/api/terminals/:id', requireToken, (req, res) => {
  const terminal = terminals.get(req.params.id);
  if (!terminal) {
    return res.status(404).json({ error: { code: 'not_found', message: 'Terminal not found.' } });
  }
  res.json({
    id: terminal.id,
    toolId: terminal.toolId,
    cwd: terminal.cwd,
    cols: terminal.cols,
    rows: terminal.rows,
    status: terminal.status,
    exitCode: terminal.exitCode,
    pid: terminal.child.pid,
  });
});

app.get('/vendor/xterm.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'));
});
app.get('/vendor/xterm.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'));
});
app.get('/vendor/addon-fit.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/ws/terminals/')) {
    socket.destroy();
    return;
  }
  const terminalId = url.pathname.slice('/ws/terminals/'.length);
  const terminal = terminals.get(terminalId);
  if (url.searchParams.get('token') !== TOKEN || !terminal || !originAllowed(req.headers.origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, terminal);
  });
});

wss.on('connection', (ws, req, terminal) => {
  terminal.sockets.add(ws);

  ws.send(JSON.stringify({ type: 'status', status: terminal.status, pid: terminal.child.pid }));
  if (terminal.buffer) {
    ws.send(JSON.stringify({ type: 'output', data: terminal.buffer }));
  }

  ws.on('message', (raw) => {
    if (raw.length > MAX_INPUT_BYTES) {
      ws.close(1009, 'Message too large');
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
      return;
    }
    if (message.type === 'input' && typeof message.data === 'string') {
      if (terminal.status === 'running') terminal.child.write(message.data);
      return;
    }
    if (message.type === 'resize') {
      const cols = clampInteger(message.cols, 2, 500, terminal.cols);
      const rows = clampInteger(message.rows, 1, 200, terminal.rows);
      terminal.cols = cols;
      terminal.rows = rows;
      if (terminal.status === 'running') terminal.child.resize(cols, rows);
    }
  });

  ws.on('close', () => {
    terminal.sockets.delete(ws);
  });
});

function shutdown() {
  for (const terminal of terminals.values()) {
    if (terminal.status === 'running') {
      terminal.child.kill();
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  actualPort = server.address().port;
  console.log(`DevPilot P0 terminal proof: http://${HOST}:${actualPort}/?token=${TOKEN}`);
  console.log(`Health: http://${HOST}:${actualPort}/api/health (send x-devpilot-token header)`);
  for (const tool of tools.values()) {
    console.log(`Tool ${tool.id}: ${tool.status}${tool.command ? ` (${tool.command})` : ''}`);
  }
});
