import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import { DEFAULT_MAX_TERMINALS_PER_SESSION } from '../limits';
import type { ProcessManager } from './processManager';
import { validateProjectPath } from './projectPaths';
import {
  displayTerminalStatus,
  deriveSessionStatus,
  refreshSessionStatus,
  type SessionDisplayStatus,
  type TerminalDisplayStatus,
} from './sessionStatus';
import { probeExecutable } from './toolProbe';
import {
  getToolProfile,
  listToolProfiles,
  updateToolCheck,
  type ToolProfile,
} from './toolRegistry';
import { verifiedProbeArgs } from './toolCatalog';

const TOOL_CHECK_FRESH_MS = 5 * 60 * 1000;

export type SessionMode = 'quick' | 'custom';

export interface CreateSessionInput {
  projectId: string;
  mode: SessionMode;
  toolIds?: string[];
  title?: string;
}

export interface SessionTerminal {
  id: string;
  toolProfileId: string;
  toolName: string;
  status: TerminalDisplayStatus;
  pid: number | null;
  exitCode: number | null;
  errorCode: string | null;
  lastError: string | null;
  startedAt: string | null;
  endedAt: string | null;
  restartCount: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionDisplayStatus;
  project: {
    id: string;
    name: string;
    path: string;
  };
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  terminals: SessionTerminal[];
}

interface ProjectLaunchRow {
  id: string;
  name: string;
  path: string;
  path_key: string;
}

interface SessionRow {
  id: string;
  title: string;
  mode: SessionMode;
  project_id: string;
  project_name: string;
  project_path: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
}

interface TerminalRow {
  id: string;
  tool_profile_id: string;
  display_name: string;
  process_status: string;
  process_pid: number | null;
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
  last_error: string | null;
  error_code: string | null;
  restart_count: number;
}

interface TerminalContext {
  terminalId: string;
  sessionId: string;
  project: ProjectLaunchRow;
  tool: ToolProfile;
}

const SESSION_COLUMNS = `
  s.id,
  s.title,
  s.mode,
  s.project_id,
  s.created_at,
  s.updated_at,
  s.last_opened_at,
  p.name AS project_name,
  p.path AS project_path
`;

function defaultTitle(projectName: string): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${projectName} ${stamp}`.slice(0, 120);
}

function mapTerminal(row: TerminalRow): SessionTerminal {
  return {
    id: row.id,
    toolProfileId: row.tool_profile_id,
    toolName: row.display_name,
    status: displayTerminalStatus(row.process_status, row.error_code),
    pid: row.process_pid,
    exitCode: row.exit_code,
    errorCode: row.error_code,
    lastError: row.last_error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    restartCount: Number(row.restart_count),
  };
}

function mapSession(row: SessionRow, terminals: TerminalRow[]): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    status: deriveSessionStatus(terminals),
    project: {
      id: row.project_id,
      name: row.project_name,
      path: row.project_path,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    terminals: terminals.map(mapTerminal),
  };
}

function getSessionRow(db: Db, id: string): SessionRow {
  const row = db
    .prepare(
      `SELECT ${SESSION_COLUMNS}
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       WHERE s.id = ?`,
    )
    .get(id) as SessionRow | undefined;
  if (!row) throw new ApiError(404, 'session_not_found', 'Session not found.');
  return row;
}

function getTerminalRows(db: Db, sessionId: string): TerminalRow[] {
  return db
    .prepare(
      `SELECT st.id, st.tool_profile_id, tp.display_name, st.process_status,
              st.process_pid, st.exit_code, st.started_at, st.ended_at,
              st.last_error, st.error_code, st.restart_count
       FROM session_terminals st
       JOIN tool_profiles tp ON tp.id = st.tool_profile_id
       WHERE st.session_id = ?
       ORDER BY st.started_at IS NULL, st.started_at, st.id`,
    )
    .all(sessionId) as TerminalRow[];
}

function getProjectLaunchRow(db: Db, projectId: string): ProjectLaunchRow {
  const row = db
    .prepare('SELECT id, name, path, path_key FROM projects WHERE id = ?')
    .get(projectId) as ProjectLaunchRow | undefined;
  if (!row) throw new ApiError(404, 'project_not_found', 'Project not found.');
  return row;
}

async function ensureProjectLaunchable(project: ProjectLaunchRow): Promise<string> {
  let canonical: { path: string; pathKey: string };
  try {
    canonical = await validateProjectPath(project.path);
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(
        409,
        'project_path_unavailable',
        `The project folder is unavailable: ${error.message}`,
      );
    }
    throw error;
  }

  if (canonical.pathKey !== project.path_key.toLowerCase()) {
    throw new ApiError(
      409,
      'project_path_changed',
      'The project folder now resolves to a different location. Refresh the project before launching.',
    );
  }
  return canonical.path;
}

async function ensureToolLaunchable(toolId: string, db: Db): Promise<ToolProfile> {
  const tool = getToolProfile(db, toolId);
  if (!tool) {
    throw new ApiError(400, 'tool_not_found', 'CLI profile not found.');
  }
  if (!tool.enabled) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName} is disabled in the CLI registry.`,
    );
  }
  if (!tool.launchVerified) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName} does not have a verified interactive launch.`,
    );
  }
  if (!tool.command) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName} has no configured executable.`,
    );
  }
  if (!path.isAbsolute(tool.command)) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName} must use an absolute executable path.`,
    );
  }

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(tool.command);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      updateToolCheck(db, tool.id, 'missing', new Date().toISOString());
      throw new ApiError(
        409,
        'tool_missing',
        `${tool.displayName}: the configured executable was not found.`,
      );
    }
    throw new ApiError(
      409,
      'tool_unavailable',
      `${tool.displayName}: the configured executable could not be checked.`,
    );
  }
  if (!stats.isFile()) {
    updateToolCheck(db, tool.id, 'missing', new Date().toISOString());
    throw new ApiError(
      409,
      'tool_missing',
      `${tool.displayName}: the configured executable is not a file.`,
    );
  }

  const checkedAt = tool.lastCheckedAt ? Date.parse(tool.lastCheckedAt) : Number.NaN;
  const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt <= TOOL_CHECK_FRESH_MS;
  if (!fresh || tool.lastStatus !== 'available') {
    const probeArgs = verifiedProbeArgs(tool.id);
    if (!probeArgs) {
      throw new ApiError(
        409,
        'tool_probe_unavailable',
        `${tool.displayName}: no verified non-interactive check is available.`,
      );
    }
    const result = await probeExecutable(tool.command, probeArgs);
    updateToolCheck(db, tool.id, result.status, result.checkedAt);
    if (result.status !== 'available') {
      throw new ApiError(
        409,
        result.status === 'missing' ? 'tool_missing' : 'tool_probe_failed',
        `${tool.displayName}: the executable could not be verified.`,
      );
    }
  }

  const updated = getToolProfile(db, tool.id);
  if (!updated || !updated.launchable) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName}: ${updated?.launchReason ?? 'this profile cannot be launched.'}`,
    );
  }
  return updated;
}

function resolveQuickToolIds(db: Db): string[] {
  const defaults = listToolProfiles(db).filter((tool) => tool.defaultOnQuickStart);
  const eligible = defaults.filter((tool) => tool.launchable);
  if (eligible.length === 0) {
    const reason =
      defaults.length === 0
        ? 'No CLI profile is marked for Quick Start.'
        : defaults
            .map((tool) => `${tool.displayName}: ${tool.launchReason ?? 'not launchable'}`)
            .join(' ');
    throw new ApiError(409, 'quick_start_unavailable', `Quick Start is unavailable. ${reason}`);
  }
  return [eligible[0]!.id];
}

function terminalWrite(
  db: Db,
  terminalId: string,
  status: 'starting' | 'running' | 'exited' | 'stopped' | 'error',
  errorCode: string | null,
  lastError: string | null,
): void {
  db.prepare(
    `UPDATE session_terminals
     SET process_status = ?, process_pid = NULL, exit_code = NULL,
         ended_at = ?, last_error = ?, error_code = ?
     WHERE id = ?`,
  ).run(status, new Date().toISOString(), lastError, errorCode, terminalId);
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly manager: ProcessManager,
    readonly maxTerminalsPerSession = DEFAULT_MAX_TERMINALS_PER_SESSION,
  ) {}

  list(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_COLUMNS}
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         ORDER BY s.updated_at DESC, s.created_at DESC`,
      )
      .all() as SessionRow[];
    return rows.map((row) => mapSession(row, getTerminalRows(this.db, row.id)));
  }

  get(id: string): SessionSummary {
    const row = getSessionRow(this.db, id);
    return mapSession(row, getTerminalRows(this.db, id));
  }

  markOpened(id: string, now = new Date().toISOString()): SessionSummary {
    const result = this.db
      .prepare('UPDATE sessions SET last_opened_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    if (result.changes === 0) {
      throw new ApiError(404, 'session_not_found', 'Session not found.');
    }
    return this.get(id);
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    const project = getProjectLaunchRow(this.db, input.projectId);
    const cwd = await ensureProjectLaunchable(project);

    const toolIds =
      input.mode === 'quick'
        ? resolveQuickToolIds(this.db)
        : (input.toolIds ?? []);
    if (toolIds.length === 0) {
      throw new ApiError(400, 'invalid_request', 'Select at least one CLI profile.');
    }
    if (toolIds.length > this.maxTerminalsPerSession) {
      throw new ApiError(
        400,
        'terminal_limit',
        `A session can start at most ${this.maxTerminalsPerSession} terminals.`,
      );
    }
    if (new Set(toolIds).size !== toolIds.length) {
      throw new ApiError(400, 'invalid_request', 'Duplicate CLI profiles are not allowed.');
    }

    const tools: ToolProfile[] = [];
    for (const toolId of toolIds) {
      tools.push(await ensureToolLaunchable(toolId, this.db));
    }

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const title = (input.title?.trim() || defaultTitle(project.name)).slice(0, 120);
    const terminals = tools.map((tool) => ({
      id: crypto.randomUUID(),
      tool,
    }));

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions
             (id, title, project_id, status, mode, created_at, updated_at)
           VALUES (?, ?, ?, 'created', ?, ?, ?)`,
        )
        .run(sessionId, title, project.id, input.mode, now, now);
      const insertTerminal = this.db.prepare(
        `INSERT INTO session_terminals
           (id, session_id, tool_profile_id, process_status, restart_count)
         VALUES (?, ?, ?, 'starting', 0)`,
      );
      for (const terminal of terminals) {
        insertTerminal.run(terminal.id, sessionId, terminal.tool.id);
      }
      this.db
        .prepare('UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, project.id);
    })();

    for (const terminal of terminals) {
      try {
        await this.manager.start({
          terminalId: terminal.id,
          sessionId,
          file: terminal.tool.command,
          args: terminal.tool.fixedArgs,
          cwd,
        });
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'start_failed';
        const message =
          error instanceof ApiError ? error.message : 'The terminal could not be started.';
        terminalWrite(this.db, terminal.id, 'error', code, message);
        refreshSessionStatus(this.db, sessionId);
      }
    }

    return this.get(sessionId);
  }

  async restartTerminal(
    terminalId: string,
    expectedSessionId?: string,
  ): Promise<SessionSummary> {
    const context = await this.getTerminalContext(terminalId, expectedSessionId);
    await ensureProjectLaunchable(context.project);
    await ensureToolLaunchable(context.tool.id, this.db);

    await this.manager.restart(terminalId, async () => {
      const current = await this.getTerminalContext(terminalId, expectedSessionId);
      const cwd = await ensureProjectLaunchable(current.project);
      const tool = await ensureToolLaunchable(current.tool.id, this.db);
      return {
        terminalId,
        sessionId: current.sessionId,
        file: tool.command,
        args: tool.fixedArgs,
        cwd,
      };
    });

    return this.get(context.sessionId);
  }

  async stopTerminal(terminalId: string, expectedSessionId?: string): Promise<SessionSummary> {
    const row = this.db
      .prepare('SELECT session_id FROM session_terminals WHERE id = ?')
      .get(terminalId) as { session_id: string } | undefined;
    if (!row || (expectedSessionId && row.session_id !== expectedSessionId)) {
      throw new ApiError(404, 'terminal_not_found', 'Terminal not found.');
    }

    await this.manager.stop(terminalId);
    return this.get(row.session_id);
  }

  async stopSession(sessionId: string): Promise<SessionSummary> {
    const session = this.get(sessionId);
    let firstError: unknown;

    for (const terminal of session.terminals) {
      if (!this.manager.hasLive(terminal.id)) continue;
      try {
        await this.manager.stop(terminal.id);
      } catch (error) {
        firstError ??= error;
      }
    }

    const now = new Date().toISOString();
    for (const terminal of session.terminals) {
      if (terminal.status !== 'starting' && terminal.status !== 'running') continue;
      if (this.manager.hasLive(terminal.id)) continue;
      terminalWrite(this.db, terminal.id, 'stopped', null, 'Stopped by user.');
      refreshSessionStatus(this.db, sessionId, now);
    }

    if (firstError) throw firstError;
    return this.get(sessionId);
  }

  private async getTerminalContext(
    terminalId: string,
    expectedSessionId?: string,
  ): Promise<TerminalContext> {
    const row = this.db
      .prepare(
        `SELECT st.id, st.session_id, st.tool_profile_id,
                p.id AS project_id, p.name AS project_name, p.path AS project_path,
                p.path_key AS project_path_key
         FROM session_terminals st
         JOIN sessions s ON s.id = st.session_id
         JOIN projects p ON p.id = s.project_id
         WHERE st.id = ?`,
      )
      .get(terminalId) as
      | {
          id: string;
          session_id: string;
          tool_profile_id: string;
          project_id: string;
          project_name: string;
          project_path: string;
          project_path_key: string;
        }
      | undefined;

    if (!row || (expectedSessionId && row.session_id !== expectedSessionId)) {
      throw new ApiError(404, 'terminal_not_found', 'Terminal not found.');
    }
    const tool = getToolProfile(this.db, row.tool_profile_id);
    if (!tool) throw new ApiError(404, 'tool_not_found', 'CLI profile not found.');

    return {
      terminalId: row.id,
      sessionId: row.session_id,
      project: {
        id: row.project_id,
        name: row.project_name,
        path: row.project_path,
        path_key: row.project_path_key,
      },
      tool,
    };
  }
}
