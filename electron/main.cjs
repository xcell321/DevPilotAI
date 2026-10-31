/**
 * DevPilot AI - Electron main process.
 *
 * Starts the Express backend as a child process, waits until it is
 * healthy, then opens the desktop window pointed at it. On quit the
 * backend child is terminated.
 *
 * Dev vs packaged:
 *  - Dev:  expects `npm run dev` already running (backend on DEVPILOT_PORT
 *          or auto port). Set DEVPILOT_ELECTRON_DEV=1 to skip spawning.
 *  - Prod: spawns `server/dist/index.js` from the packaged resources.
 */
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const isDev = process.env.DEVPILOT_ELECTRON_DEV === '1';
const isPackaged = app.isPackaged;

let backendChild = null;
let mainWindow = null;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function repoRoot() {
  // In dev: <repo>/electron/main.cjs -> <repo>
  // In prod: resources/app.asar -> unpacked to resources/app
  if (isPackaged) {
    return path.join(process.resourcesPath, 'app');
  }
  return path.resolve(__dirname, '..');
}

function backendEntry() {
  return path.join(repoRoot(), 'server', 'dist', 'index.js');
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

function startBackend() {
  if (isDev) {
    console.log('[electron] dev mode: expecting backend already running');
    return Promise.resolve();
  }

  const entry = backendEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(
      `[electron] backend entry not found: ${entry}\n` +
        'Run `npm run build -w server` before packaging.'
    );
  }

  console.log('[electron] spawning backend:', entry);
  backendChild = spawn(process.execPath, [entry], {
    cwd: repoRoot(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backendChild.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backendChild.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backendChild.on('exit', (code) => {
    console.log(`[electron] backend exited with code ${code}`);
    backendChild = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-stopped', code);
    }
  });

  return waitForBackend();
}

function backendPort() {
  const port = Number(process.env.DEVPILOT_PORT || 0);
  return port > 0 ? port : null; // null = auto port, probe common fallback
}

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 2000 },
      (res) => resolve(res.statusCode === 200)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(timeoutMs = 30000) {
  // If a fixed port is configured, poll it directly.
  const fixedPort = backendPort();
  if (fixedPort) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await checkHealth(fixedPort)) return fixedPort;
      await sleep(500);
    }
    throw new Error(`[electron] backend not healthy on port ${fixedPort}`);
  }

  // Auto port: the dev runner writes the runtime file; in packaged mode
  // we read it from the runtime dir. Fall back to scanning recent ports.
  // Simplest reliable probe: try the default Vite/backend ports.
  const candidates = [5173, 3000, 3001, 8080];
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const port of candidates) {
      if (await checkHealth(port)) return port;
    }
    await sleep(500);
  }
  throw new Error('[electron] backend did not become healthy in time');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stopBackend() {
  return new Promise((resolve) => {
    if (!backendChild) return resolve();
    const child = backendChild;
    backendChild = null;
    child.on('exit', () => resolve());
    // Graceful first, then force.
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
      resolve();
    }, 5000);
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(backendPort) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'DevPilot AI',
    backgroundColor: '#0F100E',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url = `http://127.0.0.1:${backendPort}`;
  console.log('[electron] loading:', url);
  mainWindow.loadURL(url);

  // Open external links in the system browser, not the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith('http://127.0.0.1')) {
      shell.openExternal(target);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    await startBackend();
    const port = backendPort() || (await waitForBackend());
    createWindow(port);
  } catch (err) {
    console.error(err.message || err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && mainWindow === null) {
      // Re-create window if backend still alive.
      waitForBackend(5000)
        .then((port) => createWindow(port))
        .catch(() => app.quit());
    }
  });
});

app.on('window-all-closed', async () => {
  await stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  await stopBackend();
});
