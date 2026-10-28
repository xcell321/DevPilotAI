import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { createToken } from './security/auth';
import { createPtyLauncher } from './services/processLauncher';
import { ProcessManager } from './services/processManager';
import { SessionService } from './services/sessions';
import { reconcileStaleTerminals, shutdownRuntime } from './services/startup';
import { seedToolProfiles } from './services/toolRegistry';
import { detectTerminalSupport } from './terminalSupport';
import { attachTerminalBridge } from './ws/terminalBridge';

function restrictTokenFilePermissions(file: string): void {
  if (process.platform !== 'win32') return;

  const identity = spawnSync('whoami', [], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const account = identity.status === 0 ? identity.stdout.trim() : '';
  if (!account) {
    console.warn('Could not determine the current Windows account for token-file permissions.');
    return;
  }

  const result = spawnSync(
    'icacls',
    [file, '/inheritance:r', '/grant:r', `${account}:(F)`],
    { stdio: 'ignore', windowsHide: true },
  );
  if (result.status !== 0) {
    console.warn('Could not restrict token-file permissions to the current Windows account.');
  }
}

const config = loadConfig();

fs.mkdirSync(config.runtimeDir, { recursive: true });

const db = openDatabase(config.dbPath);
seedToolProfiles(db);
const reconciled = reconcileStaleTerminals(db);
if (reconciled > 0) {
  console.log(`Marked ${reconciled} stale terminal(s) from the previous backend run.`);
}

const token = createToken();
const terminalSupport = detectTerminalSupport();
const processManager = new ProcessManager({
  db,
  launcher: createPtyLauncher(),
  maxLive: config.maxTerminals,
});
const sessionService = new SessionService(db, processManager);
const app = createApp({
  config,
  db,
  token,
  terminalSupport,
  processManager,
  sessionService,
});

const server = app.listen(config.port, config.host, () => {
  const address = server.address() as AddressInfo;
  const origin = `http://${config.host}:${address.port}`;
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;

  fs.writeFileSync(
    config.tokenFile,
    JSON.stringify(
      {
        origin,
        host: config.host,
        port: address.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  restrictTokenFilePermissions(config.tokenFile);

  console.log(`DevPilot AI server ${config.version}`);
  console.log(`  Local:      ${origin}`);
  console.log(`  Health:     ${origin}/api/health`);
  console.log(`  Database:   ${config.dbPath}`);
  console.log(`  Schema:     v${schemaVersion}`);
  console.log(`  Terminal:   ${terminalSupport.status} (${terminalSupport.detail})`);
  console.log(`  Local auth: required on /api/* except /api/health`);
  console.log(`  Token file: ${config.tokenFile}`);
});

const terminalBridge = attachTerminalBridge({
  server,
  token,
  manager: processManager,
  sessions: sessionService,
});

server.on('error', (error) => {
  console.error(`DevPilot server failed to start: ${error.message}`);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  const forceTimer = setTimeout(() => process.exit(1), 8000);
  forceTimer.unref();

  terminalBridge.close();
  void shutdownRuntime({
    server,
    db,
    processManager,
    cleanup: () => {
      try {
        const runtime = JSON.parse(fs.readFileSync(config.tokenFile, 'utf8')) as {
          pid?: number;
        };
        if (runtime.pid === process.pid) fs.rmSync(config.tokenFile, { force: true });
      } catch {
        // Runtime file already gone.
      }
    },
  })
    .then(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    })
    .catch((error: unknown) => {
      clearTimeout(forceTimer);
      console.error(
        `DevPilot shutdown failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      process.exit(1);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
