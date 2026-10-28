import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db/types';
import { seedToolProfiles } from '../src/services/toolRegistry';
import { WORKSPACE_PREFERENCES_KEY } from '../src/services/workspacePreferences';

const TOKEN = 'test-token-0123456789abcdef';
const NOW = '2026-10-29T12:00:00.000Z';

let tempDir: string;
let config: AppConfig;
let db: Db;
let app: ReturnType<typeof createApp>;

function createTestApp(database: Db): ReturnType<typeof createApp> {
  return createApp({
    config,
    db: database,
    token: TOKEN,
    terminalSupport: { status: 'available', detail: 'test-only check; no process spawned' },
  });
}

function authorized(
  method: 'get' | 'post' | 'patch' | 'delete',
  url: string,
  target = app,
) {
  return request(target)[method](url).set('x-devpilot-token', TOKEN);
}

function insertWorkspaceData(database: Db): void {
  database
    .prepare(
      `INSERT INTO projects (id, name, path, path_key, created_at, updated_at)
       VALUES ('project-1', 'Project One', 'C:\\Work\\ProjectOne', 'c:\\work\\projectone', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO sessions (id, title, project_id, status, mode, created_at, updated_at)
       VALUES ('session-1', 'Session One', 'project-1', 'stopped', 'custom', ?, ?)`,
    )
    .run(NOW, NOW);
  database
    .prepare(
      `INSERT INTO session_terminals
         (id, session_id, tool_profile_id, process_status)
       VALUES ('terminal-1', 'session-1', 'claude', 'stopped')`,
    )
    .run();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-settings-'));
  config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  app = createTestApp(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('workspace preferences', () => {
  it('returns validated defaults for a new database', async () => {
    const response = await authorized('get', '/api/settings/workspace');

    expect(response.status).toBe(200);
    expect(response.body.preferences).toEqual({
      version: 1,
      selectedProjectId: null,
      selectedSessionId: null,
      maximizedTerminalId: null,
      terminalLayout: 'auto',
    });
  });

  it('persists valid selections across a new server instance', async () => {
    insertWorkspaceData(db);
    const saved = await authorized('patch', '/api/settings/workspace').send({
      version: 1,
      selectedProjectId: 'project-1',
      selectedSessionId: 'session-1',
      maximizedTerminalId: 'terminal-1',
      terminalLayout: 'single',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.preferences).toEqual({
      version: 1,
      selectedProjectId: 'project-1',
      selectedSessionId: 'session-1',
      maximizedTerminalId: 'terminal-1',
      terminalLayout: 'single',
    });

    const dbPath = config.dbPath;
    db.close();
    db = openDatabase(dbPath);
    app = createTestApp(db);

    const restored = await authorized('get', '/api/settings/workspace');
    expect(restored.status).toBe(200);
    expect(restored.body.preferences).toEqual(saved.body.preferences);
  });

  it('drops stale identifiers and clears a maximized terminal when the session changes', async () => {
    insertWorkspaceData(db);
    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, mode, created_at, updated_at)
       VALUES ('session-2', 'Session Two', 'project-1', 'stopped', 'custom', ?, ?)`,
    ).run(NOW, NOW);

    const first = await authorized('patch', '/api/settings/workspace').send({
      version: 1,
      selectedProjectId: 'missing-project',
      selectedSessionId: 'session-1',
      maximizedTerminalId: 'terminal-1',
    });
    expect(first.body.preferences).toEqual({
      version: 1,
      selectedProjectId: null,
      selectedSessionId: 'session-1',
      maximizedTerminalId: 'terminal-1',
      terminalLayout: 'auto',
    });

    const changed = await authorized('patch', '/api/settings/workspace').send({
      version: 1,
      selectedSessionId: 'session-2',
    });
    expect(changed.body.preferences.maximizedTerminalId).toBeNull();
    expect(changed.body.preferences.selectedSessionId).toBe('session-2');

    const staleTerminal = await authorized('patch', '/api/settings/workspace').send({
      version: 1,
      selectedSessionId: 'session-1',
      maximizedTerminalId: 'missing-terminal',
    });
    expect(staleTerminal.body.preferences.maximizedTerminalId).toBeNull();
  });

  it('rejects invalid versions, unknown fields, and malformed stored JSON', async () => {
    const noVersion = await authorized('patch', '/api/settings/workspace').send({
      selectedSessionId: 'session-1',
    });
    expect(noVersion.status).toBe(400);
    expect(noVersion.body.error.code).toBe('invalid_settings');

    const wrongVersion = await authorized('patch', '/api/settings/workspace').send({
      version: 2,
      selectedSessionId: 'session-1',
    });
    expect(wrongVersion.status).toBe(400);

    const unknownField = await authorized('patch', '/api/settings/workspace').send({
      version: 1,
      command: 'whoami',
    });
    expect(unknownField.status).toBe(400);

    db.prepare(
      `INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?)`,
    ).run(WORKSPACE_PREFERENCES_KEY, '{not-json', NOW);
    const malformed = await authorized('get', '/api/settings/workspace');
    expect(malformed.body.preferences.version).toBe(1);
    expect(malformed.body.preferences.selectedSessionId).toBeNull();

    db.prepare('UPDATE app_settings SET value_json = ? WHERE key = ?').run(
      JSON.stringify({ version: 99, selectedSessionId: 'session-1' }),
      WORKSPACE_PREFERENCES_KEY,
    );
    const unsupported = await authorized('get', '/api/settings/workspace');
    expect(unsupported.body.preferences.selectedSessionId).toBeNull();
    expect(unsupported.body.preferences.terminalLayout).toBe('auto');
  });

  it('requires the local token', async () => {
    const response = await request(app).get('/api/settings/workspace');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });
});

describe('session history timestamps', () => {
  it('records when a session workspace was last opened', async () => {
    insertWorkspaceData(db);
    const before = await authorized('get', '/api/sessions/session-1');
    expect(before.body.session.lastOpenedAt).toBeNull();

    const opened = await authorized('post', '/api/sessions/session-1/open');
    expect(opened.status).toBe(200);
    expect(opened.body.session.lastOpenedAt).toBeTruthy();
    expect(opened.body.session.updatedAt).toBe(opened.body.session.lastOpenedAt);

    const stored = db
      .prepare('SELECT last_opened_at FROM sessions WHERE id = ?')
      .get('session-1') as { last_opened_at: string };
    expect(stored.last_opened_at).toBe(opened.body.session.lastOpenedAt);

    const list = await authorized('get', '/api/sessions');
    expect(list.body.sessions[0].lastOpenedAt).toBe(opened.body.session.lastOpenedAt);
  });

  it('restores session history and the last-opened timestamp from SQLite', async () => {
    insertWorkspaceData(db);
    const opened = await authorized('post', '/api/sessions/session-1/open');
    const openedAt = opened.body.session.lastOpenedAt as string;

    const dbPath = config.dbPath;
    db.close();
    db = openDatabase(dbPath);
    app = createTestApp(db);

    const history = await authorized('get', '/api/sessions');
    expect(history.status).toBe(200);
    expect(history.body.sessions).toHaveLength(1);
    expect(history.body.sessions[0].id).toBe('session-1');
    expect(history.body.sessions[0].lastOpenedAt).toBe(openedAt);
    expect(history.body.sessions[0].terminals[0].status).toBe('stopped');
  });

  it('returns a clear 404 for an unknown session', async () => {
    const response = await authorized('post', '/api/sessions/missing/open');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('session_not_found');
  });
});
