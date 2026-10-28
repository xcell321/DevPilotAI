import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase, runMigrations } from '../src/db';
import { migration001 } from '../src/db/migrations/001-initial';
import type { Db } from '../src/db/types';
import { seedToolProfiles } from '../src/services/toolRegistry';
import { probeExecutable } from '../src/services/toolProbe';

const TOKEN = 'test-token-0123456789abcdef';

let tempDir: string;
let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-api-'));
  const config = loadConfig({
    DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
    DEVPILOT_WEB_DIST: path.join(tempDir, 'no-web-build'),
  });
  db = openDatabase(config.dbPath);
  seedToolProfiles(db);
  app = createApp({
    config,
    db,
    token: TOKEN,
    terminalSupport: { status: 'available', detail: 'test-only check; no process spawned' },
  });
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function authorized(method: 'get' | 'post' | 'patch' | 'delete', url: string) {
  return request(app)[method](url).set('x-devpilot-token', TOKEN);
}

function makeProjectDir(name = 'Café 日本語 Project'): string {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync.native(directory);
}

async function addProject(projectPath = makeProjectDir(), name?: string) {
  const payload: { path: string; name?: string } = { path: projectPath };
  if (name !== undefined) payload.name = name;
  return authorized('post', '/api/projects').send(payload);
}

describe('health', () => {
  it('is public, reports terminal support, and exposes no token', async () => {
    const response = await request(app).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.app.name).toBe('DevPilot AI');
    expect(response.body.terminalSupport.status).toBe('available');
    expect(response.body.database.schemaVersion).toBe(4);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('rejects a non-loopback origin', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('Origin', 'http://malicious.example');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden_origin');
  });
});

describe('local auth', () => {
  it('rejects protected routes without a token', async () => {
    const response = await request(app).get('/api/tools');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('accepts protected routes with the local token', async () => {
    const response = await authorized('get', '/api/tools');

    expect(response.status).toBe(200);
    expect(response.body.tools).toHaveLength(4);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });

  it('does not expose sensitive environment values through the tools API', async () => {
    const secret = 'api-boundary-secret-that-must-not-leak';
    const previous = process.env.DEVPILOT_TEST_API_SECRET;
    process.env.DEVPILOT_TEST_API_SECRET = secret;
    try {
      const response = await authorized('get', '/api/tools');

      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(secret);
      expect(JSON.stringify(response.body)).not.toContain('DEVPILOT_TEST_API_SECRET');
    } finally {
      if (previous === undefined) {
        delete process.env.DEVPILOT_TEST_API_SECRET;
      } else {
        process.env.DEVPILOT_TEST_API_SECRET = previous;
      }
    }
  });

  it('rejects a foreign origin even when the token is present', async () => {
    const response = await authorized('get', '/api/overview').set(
      'Origin',
      'http://malicious.example',
    );

    expect(response.status).toBe(403);
  });

  it('rejects malformed JSON with a sanitized 400 response', async () => {
    const response = await authorized('patch', '/api/settings/workspace')
      .set('Content-Type', 'application/json')
      .send('{"version":1');

    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({
      code: 'invalid_request',
      message: 'The request body is invalid.',
    });
  });

  it('rejects oversized JSON bodies with a sanitized 413 response', async () => {
    const response = await authorized('patch', '/api/settings/workspace')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ version: 1, selectedProjectId: 'x'.repeat(70 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.body.error).toEqual({
      code: 'payload_too_large',
      message: 'The request body is too large.',
    });
  });

  it('rejects malformed session creation and unimplemented tool profile creation', async () => {
    const tools = await authorized('post', '/api/tools');
    const sessions = await authorized('post', '/api/sessions');
    const projects = await authorized('post', '/api/projects');

    expect(tools.status).toBe(404);
    expect(sessions.status).toBe(400);
    expect(sessions.body.error.code).toBe('invalid_request');
    expect(projects.status).toBe(400);
    expect(projects.body.error.code).toBe('invalid_request');
  });
});

describe('seeded tool profiles', () => {
  it('matches the verified P0 launch data and keeps unverified tools disabled', async () => {
    const response = await authorized('get', '/api/tools');
    const tools = Object.fromEntries(
      response.body.tools.map((tool: { id: string }) => [tool.id, tool]),
    ) as Record<string, {
      id: string;
      command: string;
      fixedArgs: string[];
      enabled: boolean;
      defaultOnQuickStart: boolean;
      launchVerified: boolean;
      launchable: boolean;
      launchReason: string | null;
      lastStatus: string;
      notes: string;
    }>;

    if (tools.claude?.command) {
      expect(path.isAbsolute(tools.claude.command)).toBe(true);
      expect(['available', 'missing']).toContain(tools.claude.lastStatus);
    } else {
      expect(tools.claude?.lastStatus).toBe('unverified');
    }
    expect(tools.claude?.enabled).toBe(true);
    expect(tools.claude?.defaultOnQuickStart).toBe(true);
    expect(tools.claude?.launchVerified).toBe(true);
    expect(tools.claude?.fixedArgs).toEqual([]);

    expect(tools.opencode?.enabled).toBe(false);
    expect(tools.opencode?.launchVerified).toBe(false);
    expect(tools.opencode?.launchable).toBe(false);
    expect(tools.opencode?.launchReason).toContain('Disabled');
    expect(tools.opencode?.notes).toContain('blank');

    expect(tools.freebuff?.enabled).toBe(false);
    expect(tools.freebuff?.launchable).toBe(false);
    expect(tools.freebuff?.notes).toContain('not verified');

    expect(tools.antigravity?.command).toBe('');
    expect(tools.antigravity?.enabled).toBe(false);
    expect(tools.antigravity?.launchable).toBe(false);
    expect(tools.antigravity?.lastStatus).toBe('unverified');
  });
});

describe('overview', () => {
  it('returns real zero counts and the seeded profiles', async () => {
    const response = await authorized('get', '/api/overview');

    expect(response.status).toBe(200);
    expect(response.body.counts).toEqual({
      projects: 0,
      sessions: 0,
      toolProfiles: 4,
      enabledToolProfiles: 1,
      runningTerminals: 0,
    });
    expect(response.body.limits).toEqual({ maxTerminalsPerSession: 4 });
    expect(response.body.tools).toHaveLength(4);
  });
});

describe('database schema and migrations', () => {
  it('creates the five plan tables plus the schema version table', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'app_settings',
        'projects',
        'schema_migrations',
        'session_terminals',
        'sessions',
        'tool_profiles',
      ]),
    );
    expect(db.pragma('user_version', { simple: true })).toBe(4);
  });

  it('is idempotent when migrations run again', () => {
    const version = runMigrations(db);

    expect(version).toBe(4);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number })
        .count,
    ).toBe(4);
  });

  it('enforces case-insensitive uniqueness on the normalized project path', () => {
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO projects (id, name, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    insert.run('p1', 'First', 'C:\\Work\\App', now, now);
    expect(() => insert.run('p2', 'Second', 'c:\\work\\app', now, now)).toThrow();
  });
});

describe('production static build', () => {
  it('serves the SPA shell with the runtime token meta tag', async () => {
    const webDist = path.join(tempDir, 'web-dist');
    fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(webDist, 'index.html'),
      '<!doctype html><html><head><title>DevPilot</title></head><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log("app");');

    const config = loadConfig({
      DEVPILOT_DB_PATH: path.join(tempDir, 'test.db'),
      DEVPILOT_WEB_DIST: webDist,
    });
    const staticApp = createApp({
      config,
      db,
      token: TOKEN,
      terminalSupport: { status: 'available', detail: 'test-only check; no process spawned' },
    });

    const root = await request(staticApp).get('/');
    expect(root.status).toBe(200);
    expect(root.headers['cache-control']).toBe('no-store');
    expect(root.text).toContain(`<meta name="devpilot-token" content="${TOKEN}" />`);

    const nested = await request(staticApp).get('/settings');
    expect(nested.status).toBe(200);
    expect(nested.text).toContain('<div id="root"></div>');

    const asset = await request(staticApp).get('/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.text).toBe('console.log("app");');

    const missingApi = await request(staticApp).get('/api/does-not-exist');
    expect(missingApi.status).toBe(404);
    expect(missingApi.body.error.code).toBe('not_found');

    const foreignHost = await request(staticApp).get('/').set('Host', 'evil.example');
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.text).not.toContain(TOKEN);

    const foreignOrigin = await request(staticApp)
      .get('/assets/app.js')
      .set('Origin', 'http://malicious.example');
    expect(foreignOrigin.status).toBe(403);
  });
});

describe('projects', () => {
  it('creates a project from a folder with spaces and Unicode', async () => {
    const directory = makeProjectDir();
    const response = await addProject(directory, '  Café App  ');

    expect(response.status).toBe(201);
    expect(response.body.project).toMatchObject({
      name: 'Café App',
      path: directory,
      sessionsCount: 0,
      lastUsedAt: null,
      pathStatus: 'ok',
    });
    expect(response.body.project.id).toBeTruthy();
  });

  it('lists and searches projects, escaping LIKE wildcards', async () => {
    const first = await addProject(makeProjectDir('Project One'), '100% Real');
    const second = await addProject(makeProjectDir('Project Two'), 'Alpha Beta');
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const all = await authorized('get', '/api/projects');
    expect(all.status).toBe(200);
    expect(all.body.projects).toHaveLength(2);

    const literalPercent = await authorized('get', '/api/projects').query({ q: '%' });
    expect(literalPercent.body.projects).toHaveLength(1);
    expect(literalPercent.body.projects[0].name).toBe('100% Real');

    const unicodeSearch = await authorized('get', '/api/projects').query({ q: 'Café' });
    expect(unicodeSearch.body.projects).toHaveLength(0);

    const noMatch = await authorized('get', '/api/projects').query({ q: 'zzz-not-found' });
    expect(noMatch.body.projects).toHaveLength(0);
  });

  it('renames a project but keeps the path immutable', async () => {
    const created = await addProject();
    const id = created.body.project.id as string;

    const renamed = await authorized('patch', `/api/projects/${id}`).send({
      name: '  Renamed Project  ',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.project.name).toBe('Renamed Project');
    expect(renamed.body.project.path).toBe(created.body.project.path);

    const extraPath = await authorized('patch', `/api/projects/${id}`).send({
      name: 'Another',
      path: 'C:\\Windows',
    });
    expect(extraPath.status).toBe(400);
    expect(extraPath.body.error.code).toBe('invalid_request');

    const emptyName = await authorized('patch', `/api/projects/${id}`).send({ name: '   ' });
    expect(emptyName.status).toBe(400);
    expect(emptyName.body.error.code).toBe('invalid_request');
  });

  it('rejects invalid, unsafe, missing, and non-directory paths', async () => {
    const filePath = path.join(tempDir, 'not-a-folder.txt');
    fs.writeFileSync(filePath, 'sentinel');

    const cases: Array<[string, string]> = [
      ['relative\\folder', 'invalid_project_path'],
      ['\\\\server\\share', 'invalid_project_path'],
      ['\\\\?\\C:\\temp', 'invalid_project_path'],
      ['C:\\', 'invalid_project_path'],
      [path.join(tempDir, 'CON'), 'invalid_project_path'],
      ['~\\work', 'invalid_project_path'],
      [path.join(tempDir, 'missing folder'), 'path_not_found'],
      [filePath, 'path_not_directory'],
    ];

    for (const [candidate, code] of cases) {
      const response = await authorized('post', '/api/projects').send({ path: candidate });
      expect(response.status, candidate).toBe(400);
      expect(response.body.error.code, candidate).toBe(code);
      expect(response.body.error.message).toBeTruthy();
    }
  });

  it('rejects duplicate folders with different casing and slashes', async () => {
    const directory = makeProjectDir();
    expect((await addProject(directory)).status).toBe(201);

    const variant = directory
      .replace(/\\/g, '/')
      .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());

    const duplicate = await addProject(variant, 'Duplicate');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('duplicate_project');
  });

  it('removes only the registry record, never the folder or its files', async () => {
    const directory = makeProjectDir();
    const sentinel = path.join(directory, 'keep-me.txt');
    fs.writeFileSync(sentinel, 'do not delete');
    const created = await addProject(directory);
    const id = created.body.project.id as string;

    const removed = await authorized('delete', `/api/projects/${id}`);
    expect(removed.status).toBe(204);
    expect(fs.existsSync(directory)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not delete');

    const list = await authorized('get', '/api/projects');
    expect(list.body.projects).toHaveLength(0);
  });

  it('refuses to remove a project referenced by a session and terminal', async () => {
    const created = await addProject();
    const id = created.body.project.id as string;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO sessions (id, title, project_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'created', ?, ?)`,
    ).run('session-p2', 'Direct insert', id, now, now);
    db.prepare(
      `INSERT INTO session_terminals (id, session_id, tool_profile_id, process_status)
       VALUES (?, ?, 'claude', 'stopped')`,
    ).run('terminal-p2', 'session-p2');

    const removed = await authorized('delete', `/api/projects/${id}`);
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('project_in_use');
    expect((await authorized('get', '/api/projects')).body.projects).toHaveLength(1);

    const detail = await authorized('get', `/api/projects/${id}`);
    expect(detail.body.project.sessionsCount).toBe(1);
  });

  it('reports a live missing path status without persisting it', async () => {
    const directory = makeProjectDir();
    const created = await addProject(directory);
    fs.rmSync(directory, { recursive: true, force: true });

    const list = await authorized('get', '/api/projects');
    expect(list.body.projects[0].pathStatus).toBe('missing');

    const stored = db.prepare('SELECT path FROM projects WHERE id = ?').get(
      created.body.project.id,
    ) as { path: string };
    expect(stored.path).toBe(directory);
  });

  it('updates overview counts from the real database state', async () => {
    await addProject(makeProjectDir('Count One'));
    const second = await addProject(makeProjectDir('Count Two'));

    let overview = await authorized('get', '/api/overview');
    expect(overview.body.counts.projects).toBe(2);

    await authorized('delete', `/api/projects/${second.body.project.id}`);
    overview = await authorized('get', '/api/overview');
    expect(overview.body.counts.projects).toBe(1);
  });

  it('persists projects across a new server instance on the same database file', async () => {
    const dbPath = path.join(tempDir, 'persistence.db');
    const webDist = path.join(tempDir, 'no-web-build');
    const directory = makeProjectDir('Persistence Project');

    const firstConfig = loadConfig({ DEVPILOT_DB_PATH: dbPath, DEVPILOT_WEB_DIST: webDist });
    const firstDb = openDatabase(firstConfig.dbPath);
    seedToolProfiles(firstDb);
    const firstApp = createApp({
      config: firstConfig,
      db: firstDb,
      token: TOKEN,
      terminalSupport: { status: 'available', detail: 'test-only check; no process spawned' },
    });

    const created = await request(firstApp)
      .post('/api/projects')
      .set('x-devpilot-token', TOKEN)
      .send({ path: directory, name: 'Persisted' });
    expect(created.status).toBe(201);
    firstDb.close();

    const secondConfig = loadConfig({ DEVPILOT_DB_PATH: dbPath, DEVPILOT_WEB_DIST: webDist });
    const secondDb = openDatabase(secondConfig.dbPath);
    seedToolProfiles(secondDb);
    const secondApp = createApp({
      config: secondConfig,
      db: secondDb,
      token: TOKEN,
      terminalSupport: { status: 'available', detail: 'test-only check; no process spawned' },
    });

    const list = await request(secondApp)
      .get('/api/projects')
      .set('x-devpilot-token', TOKEN);
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0].name).toBe('Persisted');
    secondDb.close();
  });

  it('migrates a populated v1 database and adds the unique path key', () => {
    const legacyPath = path.join(tempDir, 'legacy.db');
    const now = new Date().toISOString();
    const legacy = new Database(legacyPath);
    legacy.exec(
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       );`,
    );
    legacy.exec(migration001.sql);
    legacy
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
      .run('initial_schema', now);
    legacy
      .prepare(
        `INSERT INTO projects (id, name, path, created_at, updated_at)
         VALUES ('legacy-project', 'Legacy', 'C:\\Work\\Legacy', ?, ?)`,
      )
      .run(now, now);
    legacy.close();

    const migrated = openDatabase(legacyPath);
    expect(migrated.pragma('user_version', { simple: true })).toBe(4);
    const row = migrated
      .prepare('SELECT path_key FROM projects WHERE id = ?')
      .get('legacy-project') as { path_key: string };
    expect(row.path_key).toBe('c:\\work\\legacy');
    const runtimeColumns = migrated
      .prepare('PRAGMA table_info(session_terminals)')
      .all() as { name: string }[];
    expect(runtimeColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['error_code', 'restart_count']),
    );
    const sessionColumns = migrated
      .prepare('PRAGMA table_info(sessions)')
      .all() as { name: string }[];
    expect(sessionColumns.map((column) => column.name)).toContain('mode');
    expect(() =>
      migrated
        .prepare(
          `INSERT INTO projects (id, name, path, path_key, created_at, updated_at)
           VALUES ('other', 'Other', 'C:\\Other', 'c:\\work\\legacy', ?, ?)`,
        )
        .run(now, now),
    ).toThrow();
    migrated.close();
  });
});

describe('folder picker security', () => {
  it('rejects the picker without the local token before opening a window', async () => {
    const response = await request(app).post('/api/system/pick-folder');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('rejects the picker from a non-loopback origin', async () => {
    const response = await authorized('post', '/api/system/pick-folder').set(
      'Origin',
      'http://malicious.example',
    );
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden_origin');
  });
});

describe('CLI probes', () => {
  it('runs verified probes for .cmd and .ps1 shims without an interactive session', async () => {
    const cmdPath = path.join(tempDir, 'probe script.cmd');
    fs.writeFileSync(cmdPath, '@echo off\r\necho 1.2.3\r\n');
    const cmdResult = await probeExecutable(cmdPath, ['--version']);
    expect(cmdResult.status).toBe('available');
    expect(cmdResult.output).toContain('1.2.3');

    const ps1Path = path.join(tempDir, 'probe script.ps1');
    fs.writeFileSync(ps1Path, 'Write-Output "4.5.6"\r\n');
    const ps1Result = await probeExecutable(ps1Path, ['--version']);
    expect(ps1Result.status).toBe('available');
    expect(ps1Result.output).toContain('4.5.6');
  });

  it('reports a missing probe target without spawning it', async () => {
    const result = await probeExecutable(path.join(tempDir, 'missing tool.exe'), ['--version']);
    expect(result.status).toBe('missing');
  });

  it('marks OpenCode unknown and keeps it disabled', async () => {
    const response = await authorized('post', '/api/tools/opencode/check');
    expect(response.status).toBe(200);
    expect(response.body.check.status).toBe('unknown');
    expect(response.body.tool.enabled).toBe(false);
    expect(response.body.tool.lastStatus).toBe('unknown');
    expect(response.body.tool.lastCheckedAt).toBeTruthy();
  });

  it('returns unconfigured for Antigravity and ignores request body arguments', async () => {
    const response = await authorized('post', '/api/tools/antigravity/check').send({
      command: 'calc.exe',
      args: ['/bad'],
    });
    expect(response.status).toBe(200);
    expect(response.body.check.status).toBe('unconfigured');
    expect(response.body.tool.command).toBe('');
    expect(response.body.tool.enabled).toBe(false);
    expect(response.body.tool.lastStatus).toBe('unverified');
  });

  it('checks Claude with a non-interactive version probe and keeps it enabled', async () => {
    const response = await authorized('post', '/api/tools/claude/check');
    expect(response.status).toBe(200);
    expect(['available', 'missing']).toContain(response.body.check.status);
    expect(response.body.tool.enabled).toBe(true);
    expect(response.body.tool.lastStatus).toBe(response.body.check.status);
  }, 15000);

  it('checks Freebuff with a non-interactive version probe without enabling it', async () => {
    const response = await authorized('post', '/api/tools/freebuff/check');
    expect(response.status).toBe(200);
    expect(['available', 'missing']).toContain(response.body.check.status);
    expect(response.body.tool.enabled).toBe(false);
    expect(response.body.tool.lastStatus).toBe(response.body.check.status);
  }, 15000);

  it('returns 404 for an unknown CLI profile', async () => {
    const response = await authorized('post', '/api/tools/does-not-exist/check');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('tool_not_found');
  });
});
describe('configuration', () => {
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ DEVPILOT_PORT: 'not-a-port' })).toThrow(/Invalid DevPilot/);
  });

  it('refuses to bind outside loopback', () => {
    expect(() =>
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_HOST: '0.0.0.0',
      }),
    ).toThrow(/loopback address/);
  });

  it('defaults to loopback and an ephemeral port', () => {
    const config = loadConfig({ DEVPILOT_DB_PATH: path.join(tempDir, 'config.db') });

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(0);
    expect(config.maxTerminals).toBe(8);
    expect(config.maxTerminalsPerSession).toBe(4);
    expect(config.webDist).toContain(path.join('apps', 'web', 'dist'));
  });

  it('resolves the default and custom runtime directories consistently', () => {
    const defaultConfig = loadConfig({ DEVPILOT_DB_PATH: path.join(tempDir, 'config.db') });
    expect(defaultConfig.runtimeDir).toBe(path.join(defaultConfig.repoRoot, '.devpilot'));
    expect(defaultConfig.tokenFile).toBe(
      path.join(defaultConfig.repoRoot, '.devpilot', 'server.json'),
    );

    const relativeConfig = loadConfig({
      DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
      DEVPILOT_RUNTIME_DIR: './runtime with spaces',
    });
    expect(relativeConfig.runtimeDir).toBe(
      path.join(relativeConfig.repoRoot, 'runtime with spaces'),
    );

    const absoluteDir = path.join(tempDir, 'absolute runtime');
    const absoluteConfig = loadConfig({
      DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
      DEVPILOT_RUNTIME_DIR: absoluteDir,
    });
    expect(absoluteConfig.runtimeDir).toBe(absoluteDir);
    expect(absoluteConfig.tokenFile).toBe(path.join(absoluteDir, 'server.json'));
  });

  it('reads and validates the per-session terminal cap', () => {
    expect(
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_MAX_TERMINALS_PER_SESSION: '2',
      }).maxTerminalsPerSession,
    ).toBe(2);
    expect(() =>
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_MAX_TERMINALS_PER_SESSION: '0',
      }),
    ).toThrow(/Invalid DevPilot/);

    expect(
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_MAX_TERMINALS: '2',
        DEVPILOT_MAX_TERMINALS_PER_SESSION: '4',
      }).maxTerminalsPerSession,
    ).toBe(2);
  });

  it('reads and validates the live-terminal cap', () => {
    expect(
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_MAX_TERMINALS: '3',
      }).maxTerminals,
    ).toBe(3);
    expect(() =>
      loadConfig({
        DEVPILOT_DB_PATH: path.join(tempDir, 'config.db'),
        DEVPILOT_MAX_TERMINALS: '0',
      }),
    ).toThrow(/Invalid DevPilot/);
  });
});
