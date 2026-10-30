import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentTaskState,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentWorkspaceSummary,
  SessionMode,
  SessionSummary,
  SessionTerminal,
  WorkspaceMode,
} from '../../../shared/api-types.cjs';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import {
  DEFAULT_MAX_TERMINALS_PER_SESSION,
  MAX_SESSION_TITLE_LENGTH,
} from '../limits';
import { inspectExecutable } from './executable';
import {
  getGitBranchName,
  createGitWorktree,
  getGitWorkspacePaths,
  removeGitWorktree,
  inspectGitRepository,
  validateGitWorkspace,
  type GitRepositorySnapshot,
} from './gitWorkspaces';
import type { ProcessManager } from './processManager';
import { validateProjectPath } from './projectPaths';
import {
  displayTerminalStatus,
  deriveSessionStatus,
  refreshSessionStatus,
} from './sessionStatus';
import { probeExecutable } from './toolProbe';
import {
  getToolProfile,
  listToolProfiles,
  updateToolCheck,
  type ToolProfile,
} from './toolRegistry';
import { verifiedProbeArgs } from './toolCatalog';
import { normalizeAgentTaskDrafts, type AgentTaskDraft } from './agentTasks';
import { FileLeaseService, resolveScopeEntries } from './fileLeases';

const TOOL_CHECK_FRESH_MS = 5 * 60 * 1000;

export type { SessionMode, SessionSummary, SessionTerminal, WorkspaceMode };

export interface CreateSessionInput {
  projectId: string;
  mode: SessionMode;
  workspaceMode?: WorkspaceMode;
  toolIds?: string[];
  tasks?: AgentTaskDraft[];
  title?: string;
}

export interface OrchestratedTaskDraft {
  toolId: string;
  description: string;
  declaredFileScope: string[];
  dependencies: number[];
}

export interface CreateOrchestratedSessionInput {
  projectId: string;
  title: string;
  tasks: OrchestratedTaskDraft[];
}

export interface AddTerminalInput {
  toolId: string;
  task?: {
    description?: string;
    declaredFileScope?: string[];
    dependencies?: string[];
  };
}

export interface UpdateAgentTaskInput {
  description?: string;
  declaredFileScope?: string[];
  dependencies?: string[];
  status?: AgentTaskStatus;
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
  workspace_mode: WorkspaceMode | null;
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
  workspace_owner_tool_profile_id: string | null;
  workspace_task_title: string | null;
  workspace_repository_root: string | null;
  workspace_path: string | null;
  workspace_working_directory: string | null;
  workspace_base_commit: string | null;
  workspace_branch_name: string | null;
  workspace_status: AgentWorkspaceSummary['status'] | null;
  workspace_error: string | null;
  task_id: string | null;
  task_description: string | null;
  task_declared_file_scope_json: string | null;
  task_dependencies_json: string | null;
  task_status: AgentTaskStatus | null;
  task_state: AgentTaskState | null;
  task_blocked_reason: string | null;
  task_changed_files_json: string | null;
  task_actual_files_json: string | null;
  task_scope_violations_json: string | null;
  task_validation_status: AgentTaskSummary['validationStatus'] | null;
  task_validation_summary: string | null;
  task_integration_status: AgentTaskSummary['integrationStatus'] | null;
  task_integration_reason: string | null;
  task_integration_commit: string | null;
  task_target_branch: string | null;
  task_completion_summary: string | null;
  task_completed_at: string | null;
}

interface TerminalContext {
  terminalId: string;
  sessionId: string;
  project: ProjectLaunchRow;
  tool: ToolProfile;
  workspace: AgentWorkspaceSummary | null;
}

const SESSION_COLUMNS = `
  s.id,
  s.title,
  s.mode,
  s.workspace_mode,
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
  return `${projectName} ${stamp}`.slice(0, MAX_SESSION_TITLE_LENGTH);
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
    workspace:
      row.workspace_status &&
      row.workspace_owner_tool_profile_id &&
      row.workspace_task_title &&
      row.workspace_repository_root &&
      row.workspace_path &&
      row.workspace_working_directory &&
      row.workspace_base_commit
        ? {
            ownerToolProfileId: row.workspace_owner_tool_profile_id,
            taskTitle: row.workspace_task_title,
            repositoryRoot: row.workspace_repository_root,
            path: row.workspace_path,
            workingDirectory: row.workspace_working_directory,
            baseCommit: row.workspace_base_commit,
            branchName: row.workspace_branch_name,
            status: row.workspace_status,
            error: row.workspace_error,
          }
        : null,
    task: row.task_id
      ? {
          id: row.task_id,
          description: row.task_description ?? '',
          declaredFileScope: JSON.parse(row.task_declared_file_scope_json ?? '[]') as string[],
          dependencies: JSON.parse(row.task_dependencies_json ?? '[]') as string[],
          status: row.task_status ?? 'unassigned',
          state: row.task_state ?? 'unassigned',
          blockedReason: row.task_blocked_reason,
          changedFiles: JSON.parse(row.task_changed_files_json ?? '[]') as string[],
          actualFiles: JSON.parse(row.task_actual_files_json ?? '[]') as string[],
          scopeViolations: JSON.parse(row.task_scope_violations_json ?? '[]') as string[],
          validationStatus: row.task_validation_status ?? 'not_configured',
          validationSummary: row.task_validation_summary,
          integrationStatus: row.task_integration_status ?? 'not_requested',
          integrationReason: row.task_integration_reason,
          integrationCommit: row.task_integration_commit,
          targetBranch: row.task_target_branch,
          branchName: row.workspace_branch_name,
          worktreePath: row.workspace_path,
          completionSummary: row.task_completion_summary,
          completedAt: row.task_completed_at,
          waitKind: null,
          deferredScope: [],
          replanCount: 0,
          agentToolId: row.tool_profile_id,
          agentName: row.display_name,
          leases: [],
        }
      : null,
  };
}

function mapSession(row: SessionRow, terminals: TerminalRow[]): SessionSummary {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    workspaceMode:
      row.workspace_mode ??
      (terminals.length > 0 &&
      terminals.every((terminal) => terminal.workspace_status !== null)
        ? 'isolated'
        : null),
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
              st.last_error, st.error_code, st.restart_count,
              aw.owner_tool_profile_id AS workspace_owner_tool_profile_id,
              aw.task_title AS workspace_task_title,
              aw.repository_root AS workspace_repository_root,
              aw.worktree_path AS workspace_path,
              aw.working_directory AS workspace_working_directory,
              aw.base_commit AS workspace_base_commit,
              aw.branch_name AS workspace_branch_name,
              aw.status AS workspace_status,
              aw.last_error AS workspace_error,
              at.id AS task_id,
              at.description AS task_description,
              at.declared_file_scope_json AS task_declared_file_scope_json,
              at.dependencies_json AS task_dependencies_json,
              at.status AS task_status,
              at.state AS task_state,
              at.blocked_reason AS task_blocked_reason,
              at.changed_files_json AS task_changed_files_json,
              at.actual_files_json AS task_actual_files_json,
              at.scope_violations_json AS task_scope_violations_json,
              at.validation_status AS task_validation_status,
              at.validation_summary AS task_validation_summary,
              at.integration_status AS task_integration_status,
              at.integration_reason AS task_integration_reason,
              at.integration_commit AS task_integration_commit,
              at.target_branch AS task_target_branch,
              at.completion_summary AS task_completion_summary,
              at.completed_at AS task_completed_at
       FROM session_terminals st
       JOIN tool_profiles tp ON tp.id = st.tool_profile_id
       LEFT JOIN agent_workspaces aw ON aw.terminal_id = st.id
       LEFT JOIN agent_tasks at ON at.terminal_id = st.id
       WHERE st.session_id = ?
       ORDER BY st.rowid`,
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
  const inspection = inspectExecutable(tool.command);
  if (!inspection.absolute) {
    throw new ApiError(
      409,
      'tool_not_launchable',
      `${tool.displayName} must use an absolute executable path.`,
    );
  }
  if (!inspection.exists) {
    if (inspection.errorCode === 'ENOENT') {
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
  if (!inspection.isFile) {
    updateToolCheck(db, tool.id, 'missing', new Date().toISOString());
    throw new ApiError(
      409,
      'tool_missing',
      `${tool.displayName}: the configured executable is not a file.`,
    );
  }
  if (!inspection.executable) {
    updateToolCheck(db, tool.id, 'missing', new Date().toISOString());
    throw new ApiError(
      409,
      'tool_unavailable',
      `${tool.displayName}: the configured executable is not executable by this account.`,
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

/**
 * Claims the writable scope of a newly created task before its CLI starts, so a
 * second session cannot edit the same files at the same time.
 */
function acquireCreationLease(
  db: Db,
  input: {
    taskId: string;
    sessionId: string;
    projectId: string;
    terminalId: string;
    toolProfileId: string;
    repositoryRoot: string;
    scopes: string[];
  },
): { ok: boolean; reason: string | null } {
  if (input.scopes.length === 0) return { ok: true, reason: null };
  let resolved;
  try {
    resolved = resolveScopeEntries(input.repositoryRoot, input.scopes);
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof ApiError
          ? error.message
          : 'The declared writable scope could not be resolved, so the agent was not started.',
    };
  }
  const decision = new FileLeaseService(db).acquire({
    taskId: input.taskId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    terminalId: input.terminalId,
    toolProfileId: input.toolProfileId,
    scopes: resolved,
  });
  if (decision.ok) return { ok: true, reason: null };
  const sample = decision.conflicts
    .slice(0, 6)
    .map(
      (conflict) =>
        `"${conflict.path}" is owned by "${conflict.ownerTaskLabel}" (${conflict.ownerState.replace(
          /_/g,
          ' ',
        )})`,
    );
  return {
    ok: false,
    reason: `Waiting for file ownership: ${sample.join('; ')}${
      decision.conflicts.length > sample.length ? ' (more…)' : ''
    }. The agent was not started and resumes when those files are released.`,
  };
}

function markTaskWaitingForFiles(db: Db, terminalId: string, reason: string): void {
  db.prepare(
    `UPDATE agent_tasks
     SET state = 'blocked', blocked_reason = ?, wait_kind = 'files', updated_at = ?
     WHERE terminal_id = ?`,
  ).run(reason, new Date().toISOString(), terminalId);
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

const QUEUED_BLOCKED_REASON = 'Waiting for dependency tasks to be integrated.';

export function initialTaskState(task: {
  description: string;
  dependencies: string[];
}): { state: AgentTaskState; blockedReason: string | null } {
  if (!task.description.trim()) return { state: 'unassigned', blockedReason: null };
  if (task.dependencies.length > 0) {
    return { state: 'blocked', blockedReason: QUEUED_BLOCKED_REASON };
  }
  return { state: 'ready', blockedReason: null };
}

function insertAgentTask(
  db: Db,
  sessionId: string,
  terminalId: string,
  task: { description: string; declaredFileScope: string[]; dependencies: string[] },
  now: string,
): void {
  const initial = initialTaskState(task);
  db.prepare(
    `INSERT INTO agent_tasks (
       id, session_id, terminal_id, description, declared_file_scope_json,
       dependencies_json, status, state, blocked_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    terminalId,
    sessionId,
    terminalId,
    task.description,
    JSON.stringify(task.declaredFileScope),
    JSON.stringify(task.dependencies),
    task.description ? 'planned' : 'unassigned',
    initial.state,
    initial.blockedReason,
    now,
    now,
  );
}

function writeTaskState(
  db: Db,
  terminalId: string,
  state: AgentTaskState,
  blockedReason: string | null = null,
): void {
  db.prepare(
    'UPDATE agent_tasks SET state = ?, blocked_reason = ?, updated_at = ? WHERE terminal_id = ?',
  ).run(state, blockedReason, new Date().toISOString(), terminalId);
}

/**
 * Shared-folder sessions run every CLI against the same writable files. More
 * than one such CLI cannot be isolated, so orchestrating code changes there is
 * rejected instead of relying on a warning.
 */
function assertSharedFolderSafety(
  workspaceMode: WorkspaceMode,
  terminalCount: number,
  tasks: Array<{ description: string }>,
): void {
  if (workspaceMode !== 'shared') return;
  if (terminalCount <= 1) return;
  if (!tasks.some((task) => task.description.trim().length > 0)) return;
  throw new ApiError(
    409,
    'shared_folder_concurrent_agents',
    'Shared Folder mode uses one writable directory, so agent tasks cannot run there safely. Create the session with Isolated Worktrees, or convert a stopped shared session to isolated worktrees first. Nothing was changed.',
  );
}

function requireWorkspaceRoot(runtimeDir: string | null): string {
  if (!runtimeDir) {
    throw new ApiError(
      500,
      'workspace_configuration_missing',
      'The isolated workspace directory is not configured.',
    );
  }
  return runtimeDir;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly manager: ProcessManager,
    readonly maxTerminalsPerSession = DEFAULT_MAX_TERMINALS_PER_SESSION,
    private readonly runtimeDir: string | null = null,
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

  get liveTerminalCount(): number {
    return this.manager.liveCount;
  }

  get maxLiveTerminals(): number {
    return this.manager.maxLiveCount;
  }

  hasLiveTerminal(terminalId: string): boolean {
    return this.manager.hasLive(terminalId);
  }

  /**
   * Starts the CLI for a task that the scheduler has already claimed. The
   * working directory always comes from the task's recorded worktree, never
   * from the shared project folder.
   */
  async startAgentTerminal(terminalId: string): Promise<void> {
    if (this.manager.hasLive(terminalId)) return;
    const context = await this.getTerminalContext(terminalId);
    const projectCwd = await ensureProjectLaunchable(context.project);
    const cwd = context.workspace
      ? await ensureWorkspaceLaunchable(context.workspace)
      : projectCwd;
    const tool = await ensureToolLaunchable(context.tool.id, this.db);

    await this.manager.start({
      terminalId,
      sessionId: context.sessionId,
      file: tool.command,
      args: tool.fixedArgs,
      cwd,
    });

    const state = this.db
      .prepare('SELECT process_status, error_code, last_error FROM session_terminals WHERE id = ?')
      .get(terminalId) as
      | { process_status: string; error_code: string | null; last_error: string | null }
      | undefined;
    if (state?.process_status === 'error') {
      throw new ApiError(
        409,
        state.error_code ?? 'start_failed',
        state.last_error ?? 'The agent CLI could not be started.',
      );
    }
  }

  updateTask(
    sessionId: string,
    terminalId: string,
    input: UpdateAgentTaskInput,
  ): SessionSummary {
    getSessionRow(this.db, sessionId);
    const terminals = getTerminalRows(this.db, sessionId);
    const target = terminals.find((terminal) => terminal.id === terminalId);
    if (!target?.task_id) {
      throw new ApiError(404, 'terminal_not_found', 'Terminal task not found.');
    }
    const currentDescription = target.task_description ?? '';
    const currentDeclaredFileScope = JSON.parse(
      target.task_declared_file_scope_json ?? '[]',
    ) as string[];
    const currentDependencies = JSON.parse(
      target.task_dependencies_json ?? '[]',
    ) as string[];
    if (input.status === 'completed') {
      throw new ApiError(
        409,
        'completion_requires_evidence',
        'A task is not completed by setting a status. Commit the work, stop the terminal, then record completion with its evidence.',
      );
    }
    if (target.task_state === 'integrated') {
      throw new ApiError(
        409,
        'task_already_integrated',
        'An integrated task assignment cannot be changed.',
      );
    }
    const assignmentChanged =
      (input.description !== undefined && input.description.trim() !== currentDescription) ||
      (input.declaredFileScope !== undefined &&
        JSON.stringify(input.declaredFileScope) !== JSON.stringify(currentDeclaredFileScope)) ||
      (input.dependencies !== undefined &&
        JSON.stringify(input.dependencies) !== JSON.stringify(currentDependencies));
    if (
      (target.process_status === 'starting' || target.process_status === 'running') &&
      assignmentChanged
    ) {
      throw new ApiError(
        409,
        'task_assignment_locked',
        'Stop this terminal before changing its task assignment or declared scope.',
      );
    }

    const drafts = normalizeAgentTaskDrafts(
      terminals.map((terminal) => terminal.id),
      terminals.map((terminal) => ({
        toolId: terminal.id,
        description:
          terminal.id === terminalId
            ? input.description ?? currentDescription
            : terminal.task_description ?? '',
        declaredFileScope:
          terminal.id === terminalId
            ? input.declaredFileScope ?? currentDeclaredFileScope
            : (JSON.parse(
                terminal.task_declared_file_scope_json ?? '[]',
              ) as string[]),
        dependencies:
          terminal.id === terminalId
            ? input.dependencies ?? currentDependencies
            : (JSON.parse(terminal.task_dependencies_json ?? '[]') as string[]),
      })),
    );
    const updated = drafts.find((task) => task.toolId === terminalId)!;
    const currentStatus = target.task_status ?? 'unassigned';
    const status =
      input.status ??
      (input.description !== undefined &&
      updated.description.length > 0 &&
      currentStatus === 'unassigned'
        ? 'planned'
        : currentStatus);

    const terminalLive =
      target.process_status === 'starting' || target.process_status === 'running';
    const initial = initialTaskState(updated);
    let nextState: AgentTaskState = target.task_state ?? 'unassigned';
    let blockedReason: string | null = target.task_blocked_reason;
    if (assignmentChanged) {
      nextState = initial.state;
      blockedReason = initial.blockedReason;
    }
    if (input.status) {
      switch (input.status) {
        case 'cancelled':
          nextState = 'cancelled';
          blockedReason = null;
          break;
        case 'failed':
          nextState = 'failed';
          blockedReason = null;
          break;
        case 'unassigned':
          nextState = 'unassigned';
          blockedReason = null;
          break;
        case 'planned':
          nextState = initial.state;
          blockedReason = initial.blockedReason;
          break;
        case 'in_progress':
          nextState = terminalLive ? 'running' : 'ready';
          blockedReason = null;
          break;
      }
    }
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_tasks
           SET description = ?, declared_file_scope_json = ?, dependencies_json = ?,
               status = ?, state = ?, blocked_reason = ?, updated_at = ?
           WHERE session_id = ? AND terminal_id = ?`,
        )
        .run(
          updated.description,
          JSON.stringify(updated.declaredFileScope),
          JSON.stringify(updated.dependencies),
          status,
          nextState,
          blockedReason,
          now,
          sessionId,
          terminalId,
        );
      if (assignmentChanged) {
        // New assignment means the previous completion evidence and writable
        // ownership no longer apply.
        this.db
          .prepare(
            `UPDATE agent_tasks
             SET completion_summary = NULL, completed_at = NULL, assigned_at = NULL,
                 actual_files_json = '[]', changed_files_json = '[]',
                 scope_violations_json = '[]', validation_status = 'not_configured',
                 validation_summary = NULL, integration_status = 'not_requested',
                 integration_reason = NULL, integration_commit = NULL,
                 target_branch = NULL, wait_kind = NULL,
                 deferred_scope_json = '[]', replan_count = 0
             WHERE session_id = ? AND terminal_id = ?`,
          )
          .run(sessionId, terminalId);
        this.db
          .prepare(
            `UPDATE agent_task_leases
             SET state = 'released', released_at = ?, release_reason = ?
             WHERE task_id = ? AND state = 'active'`,
          )
          .run(
            now,
            'The task assignment changed, so its writable scope must be re-acquired.',
            terminalId,
          );
      }
      this.db
        .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
        .run(now, sessionId);
    })();

    return this.get(sessionId);
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
    const taskDrafts = normalizeAgentTaskDrafts(toolIds, input.tasks);
    const workspaceMode: WorkspaceMode = input.workspaceMode ?? 'shared';
    assertSharedFolderSafety(workspaceMode, toolIds.length, taskDrafts);

    const tools: ToolProfile[] = [];
    for (const toolId of toolIds) {
      tools.push(await ensureToolLaunchable(toolId, this.db));
    }

    const workspaceRoot =
      workspaceMode === 'isolated' ? requireWorkspaceRoot(this.runtimeDir) : null;
    const repository = workspaceRoot ? await inspectGitRepository(cwd) : null;

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const title = (input.title?.trim() || defaultTitle(project.name)).slice(
      0,
      MAX_SESSION_TITLE_LENGTH,
    );
    const terminals = tools.map((tool) => ({
      id: crypto.randomUUID(),
      tool,
    }));
    const taskByToolId = new Map(taskDrafts.map((task) => [task.toolId, task]));
    const workspacePlans = repository && workspaceRoot
      ? terminals.map(({ id, tool }) => ({
          terminalId: id,
          ownerToolProfileId: tool.id,
          taskTitle: taskByToolId.get(tool.id)?.description || title,
          branchName: getGitBranchName(sessionId, id),
          ...getGitWorkspacePaths(workspaceRoot, repository, sessionId, id),
        }))
      : [];

    this.db.transaction(() => {
      const projectStillExists = this.db
        .prepare('SELECT 1 AS present FROM projects WHERE id = ?')
        .get(project.id);
      if (!projectStillExists) {
        throw new ApiError(
          409,
          'project_removed',
          'The project was removed before the session could be created.',
        );
      }
      this.db
        .prepare(
          `INSERT INTO sessions
             (id, title, project_id, status, mode, workspace_mode, created_at, updated_at)
           VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`,
        )
        .run(sessionId, title, project.id, input.mode, workspaceMode, now, now);
      const insertTerminal = this.db.prepare(
        `INSERT INTO session_terminals
           (id, session_id, tool_profile_id, process_status, restart_count)
         VALUES (?, ?, ?, 'starting', 0)`,
      );
      for (const terminal of terminals) {
        insertTerminal.run(terminal.id, sessionId, terminal.tool.id);
      }
      const terminalIdByToolId = new Map(
        terminals.map((terminal) => [terminal.tool.id, terminal.id]),
      );
      for (const terminal of terminals) {
        const draft = taskByToolId.get(terminal.tool.id)!;
        insertAgentTask(
          this.db,
          sessionId,
          terminal.id,
          {
            ...draft,
            dependencies: draft.dependencies.map(
              (dependencyToolId) => terminalIdByToolId.get(dependencyToolId)!,
            ),
          },
          now,
        );
      }
      if (repository) {
        const insertWorkspace = this.db.prepare(
          `INSERT INTO agent_workspaces (
             terminal_id, owner_tool_profile_id, task_title, repository_root,
             worktree_path, working_directory, base_commit, status,
             last_error, created_at, updated_at, branch_name
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?, ?)`,
        );
        for (const plan of workspacePlans) {
          insertWorkspace.run(
            plan.terminalId,
            plan.ownerToolProfileId,
            plan.taskTitle,
            repository.repositoryRoot,
            plan.worktreePath,
            plan.workingDirectory,
            repository.baseCommit,
            now,
            now,
            plan.branchName,
          );
        }
      }
      this.db
        .prepare('UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, project.id);
    })();

    let workspaceFailure = false;
    const createdWorktreePaths: string[] = [];
    let workspaceFailureError: ApiError | null = null;
    if (repository) {
      for (const plan of workspacePlans) {
        try {
          await createGitWorktree(repository, plan.worktreePath, plan.branchName);
          createdWorktreePaths.push(plan.worktreePath);
          this.db
            .prepare(
              `UPDATE agent_workspaces
               SET status = 'ready', last_error = NULL, updated_at = ?
               WHERE terminal_id = ?`,
            )
            .run(new Date().toISOString(), plan.terminalId);
        } catch (error) {
          workspaceFailure = true;
          const message =
            error instanceof ApiError
              ? error.message
              : 'The isolated Git workspace could not be created.';
          workspaceFailureError ??= error instanceof ApiError
            ? error
            : new ApiError(409, 'workspace_provision_failed', message);
          this.db
            .prepare(
              `UPDATE agent_workspaces
               SET status = 'failed', last_error = ?, updated_at = ?
               WHERE terminal_id = ?`,
            )
            .run(message, new Date().toISOString(), plan.terminalId);
          terminalWrite(
            this.db,
            plan.terminalId,
            'error',
            'workspace_provision_failed',
            message,
          );
        }
      }
    }

    if (workspaceFailure) {
      let cleanupFailed = false;
      for (const worktreePath of createdWorktreePaths) {
        try {
          await removeGitWorktree(repository!.repositoryRoot, worktreePath);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        const message = 'Isolated workspace setup failed and at least one created worktree could not be cleaned up.';
        for (const terminal of terminals) {
          terminalWrite(this.db, terminal.id, 'error', 'workspace_cleanup_failed', message);
        }
        refreshSessionStatus(this.db, sessionId);
        throw new ApiError(409, 'workspace_cleanup_failed', message);
      }
      this.db.transaction(() => {
        for (const terminal of terminals) {
          this.db.prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?').run(terminal.id);
          this.db.prepare('DELETE FROM agent_tasks WHERE terminal_id = ?').run(terminal.id);
          this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(terminal.id);
        }
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      })();
      throw workspaceFailureError ?? new ApiError(
        409,
        'workspace_provision_failed',
        'No CLI agents were started because an isolated workspace could not be created.',
      );
    }

    const workspaceCwds = new Map(
      workspacePlans.map((plan) => [plan.terminalId, plan.workingDirectory]),
    );
    const creationLeases = new Map<string, { ok: boolean; reason: string | null }>();
    if (repository) {
      for (const terminal of terminals) {
        const draft = taskByToolId.get(terminal.tool.id)!;
        creationLeases.set(
          terminal.id,
          acquireCreationLease(this.db, {
            taskId: terminal.id,
            sessionId,
            projectId: project.id,
            terminalId: terminal.id,
            toolProfileId: terminal.tool.id,
            repositoryRoot: repository.repositoryRoot,
            scopes: draft.declaredFileScope,
          }),
        );
      }
    }
    for (const terminal of terminals) {
      const draft = taskByToolId.get(terminal.tool.id)!;
      if (draft.dependencies.length > 0) {
        // Dependent tasks are started by the task scheduler only after their
        // dependencies are integrated, so the CLI never races ahead of them.
        terminalWrite(
          this.db,
          terminal.id,
          'stopped',
          'awaiting_dependencies',
          'Waiting for dependency tasks to be integrated.',
        );
        continue;
      }
      const lease = creationLeases.get(terminal.id);
      if (lease && !lease.ok) {
        markTaskWaitingForFiles(this.db, terminal.id, lease.reason!);
        terminalWrite(this.db, terminal.id, 'stopped', 'awaiting_files', lease.reason);
        continue;
      }
      try {
        await this.manager.start({
          terminalId: terminal.id,
          sessionId,
          file: terminal.tool.command,
          args: terminal.tool.fixedArgs,
          cwd: workspaceCwds.get(terminal.id) ?? cwd,
        });
        writeTaskState(this.db, terminal.id, 'running');
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'start_failed';
        const message =
          error instanceof ApiError ? error.message : 'The terminal could not be started.';
        terminalWrite(this.db, terminal.id, 'error', code, message);
        refreshSessionStatus(this.db, sessionId);
      }
    }

    // Read-back check: if any terminal failed to start (except terminal_limit which is expected capacity behavior), clean up and throw 409
    const terminalStates = this.db
      .prepare('SELECT id, process_status, error_code, last_error FROM session_terminals WHERE session_id = ?')
      .all(sessionId) as Array<{ id: string; process_status: string; error_code: string | null; last_error: string | null }>;
    const failedTerminals = terminalStates.filter(
      (ts) => ts.process_status === 'error' && ts.error_code !== 'terminal_limit',
    );
    if (failedTerminals.length > 0) {
      // Clean up session terminals and agent_tasks/agent_workspaces for failed terminals
      this.db.transaction(() => {
        for (const failed of failedTerminals) {
          this.db.prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?').run(failed.id);
          this.db.prepare('DELETE FROM agent_tasks WHERE terminal_id = ?').run(failed.id);
          this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(failed.id);
        }
        refreshSessionStatus(this.db, sessionId);
      })();
      const firstFailed = failedTerminals[0]!;
      throw new ApiError(
        409,
        firstFailed.error_code ?? 'start_failed',
        firstFailed.last_error ?? 'The terminal could not be started.',
      );
    }

    return this.get(sessionId);
  }

  /**
   * Creates an isolated session for a generated workflow. Unlike `create`, the
   * same CLI profile may serve several tasks, every task keeps its own worktree,
   * and no CLI is started here: the orchestrator launches tasks under
   * concurrency, dependency and writable-scope coordination.
   */
  async createOrchestratedSession(
    input: CreateOrchestratedSessionInput,
  ): Promise<SessionSummary> {
    const project = getProjectLaunchRow(this.db, input.projectId);
    const cwd = await ensureProjectLaunchable(project);
    if (input.tasks.length === 0) {
      throw new ApiError(400, 'invalid_request', 'A workflow needs at least one task.');
    }
    if (input.tasks.length > this.maxTerminalsPerSession) {
      throw new ApiError(
        400,
        'terminal_limit',
        `A workflow can create at most ${this.maxTerminalsPerSession} terminals for this backend.`,
      );
    }

    const keys = input.tasks.map((_task, index) => `task-${index}`);
    for (const [index, task] of input.tasks.entries()) {
      for (const dependency of task.dependencies) {
        if (
          !Number.isInteger(dependency) ||
          dependency < 0 ||
          dependency >= input.tasks.length ||
          dependency === index
        ) {
          throw new ApiError(
            400,
            'invalid_task_dependency',
            'Generated dependencies must refer to another task in the same workflow.',
          );
        }
      }
    }
    const drafts = normalizeAgentTaskDrafts(
      keys,
      input.tasks.map((task, index) => ({
        toolId: keys[index]!,
        description: task.description,
        declaredFileScope: task.declaredFileScope,
        dependencies: task.dependencies.map((dependency) => keys[dependency]!),
      })),
    );

    const tools = new Map<string, ToolProfile>();
    for (const task of input.tasks) {
      if (tools.has(task.toolId)) continue;
      tools.set(task.toolId, await ensureToolLaunchable(task.toolId, this.db));
    }

    const runtimeDir = requireWorkspaceRoot(this.runtimeDir);
    const repository = await inspectGitRepository(cwd);
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const title =
      (input.title.trim() || defaultTitle(project.name)).slice(0, MAX_SESSION_TITLE_LENGTH);
    const terminals = input.tasks.map((_task, index) => ({
      id: crypto.randomUUID(),
      tool: tools.get(input.tasks[index]!.toolId)!,
      draft: drafts[index]!,
    }));
    const terminalIdByKey = new Map(
      terminals.map((terminal, index) => [keys[index]!, terminal.id]),
    );
    const plans = terminals.map((terminal) => ({
      terminalId: terminal.id,
      ownerToolProfileId: terminal.tool.id,
      taskTitle: terminal.draft.description || title,
      branchName: getGitBranchName(sessionId, terminal.id),
      ...getGitWorkspacePaths(runtimeDir, repository, sessionId, terminal.id),
    }));

    const createdWorktreePaths: string[] = [];
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO sessions
               (id, title, project_id, status, mode, workspace_mode, created_at, updated_at)
             VALUES (?, ?, ?, 'created', 'custom', 'isolated', ?, ?)`,
          )
          .run(sessionId, title, project.id, now, now);
        const insertTerminal = this.db.prepare(
          `INSERT INTO session_terminals
             (id, session_id, tool_profile_id, process_status, restart_count)
           VALUES (?, ?, ?, 'stopped', 0)`,
        );
        for (const terminal of terminals) {
          insertTerminal.run(terminal.id, sessionId, terminal.tool.id);
        }
        for (const terminal of terminals) {
          insertAgentTask(
            this.db,
            sessionId,
            terminal.id,
            {
              description: terminal.draft.description,
              declaredFileScope: terminal.draft.declaredFileScope,
              dependencies: terminal.draft.dependencies.map(
                (dependency) => terminalIdByKey.get(dependency)!,
              ),
            },
            now,
          );
        }
        const insertWorkspace = this.db.prepare(
          `INSERT INTO agent_workspaces (
             terminal_id, owner_tool_profile_id, task_title, repository_root,
             worktree_path, working_directory, base_commit, status,
             last_error, created_at, updated_at, branch_name
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?, ?)`,
        );
        for (const plan of plans) {
          insertWorkspace.run(
            plan.terminalId,
            plan.ownerToolProfileId,
            plan.taskTitle,
            repository.repositoryRoot,
            plan.worktreePath,
            plan.workingDirectory,
            repository.baseCommit,
            now,
            now,
            plan.branchName,
          );
        }
        this.db
          .prepare('UPDATE projects SET last_used_at = ?, updated_at = ? WHERE id = ?')
          .run(now, now, project.id);
      })();

      for (const plan of plans) {
        await createGitWorktree(repository, plan.worktreePath, plan.branchName);
        createdWorktreePaths.push(plan.worktreePath);
        this.db
          .prepare(
            `UPDATE agent_workspaces SET status = 'ready', last_error = NULL, updated_at = ?
             WHERE terminal_id = ?`,
          )
          .run(new Date().toISOString(), plan.terminalId);
      }
      refreshSessionStatus(this.db, sessionId);
      return this.get(sessionId);
    } catch (error) {
      for (const worktreePath of createdWorktreePaths) {
        try {
          await removeGitWorktree(repository.repositoryRoot, worktreePath);
        } catch {
          // A leftover worktree is preserved for inspection instead of forced.
        }
      }
      this.db.transaction(() => {
        for (const plan of plans) {
          this.db.prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?').run(plan.terminalId);
          this.db.prepare('DELETE FROM agent_tasks WHERE terminal_id = ?').run(plan.terminalId);
          this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(plan.terminalId);
        }
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      })();
      throw error instanceof ApiError
        ? error
        : new ApiError(
            409,
            'workflow_provision_failed',
            'The workflow worktrees could not be created. Nothing in the project was changed.',
          );
    }
  }

  async addTerminal(
    sessionId: string,
    input: AddTerminalInput & { workspaceMode?: WorkspaceMode },
  ): Promise<SessionSummary> {
    const session = getSessionRow(this.db, sessionId);
    const project = getProjectLaunchRow(this.db, session.project_id);
    const cwd = await ensureProjectLaunchable(project);
    const existing = getTerminalRows(this.db, sessionId);
    if (existing.length >= this.maxTerminalsPerSession) {
      throw new ApiError(
        409,
        'terminal_limit',
        `This session already has the maximum of ${this.maxTerminalsPerSession} terminals.`,
      );
    }

    const tool = await ensureToolLaunchable(input.toolId, this.db);
    const terminalId = crypto.randomUUID();
    const taskDrafts = normalizeAgentTaskDrafts(
      [...existing.map((terminal) => terminal.id), terminalId],
      [
        ...existing.map((terminal) => ({
          toolId: terminal.id,
          description: terminal.task_description ?? '',
          declaredFileScope: JSON.parse(
            terminal.task_declared_file_scope_json ?? '[]',
          ) as string[],
          dependencies: JSON.parse(terminal.task_dependencies_json ?? '[]') as string[],
        })),
        {
          toolId: terminalId,
          description: input.task?.description,
          declaredFileScope: input.task?.declaredFileScope,
          dependencies: input.task?.dependencies,
        },
      ],
    );
    const newTask = taskDrafts.find((task) => task.toolId === terminalId)!;
    const workspaceRows = existing.filter((terminal) => terminal.workspace_status !== null);
    const inferredLegacyMode =
      existing.length > 0 && workspaceRows.length === existing.length
        ? 'isolated'
        : null;
    const requestedWorkspaceMode = input.workspaceMode ?? null;
    const sessionWorkspaceMode =
      session.workspace_mode ?? inferredLegacyMode ?? requestedWorkspaceMode;
    if (!sessionWorkspaceMode) {
      throw new ApiError(
        409,
        'workspace_mode_required',
        'Choose Shared Folder or Isolated Worktrees for this existing session before adding another CLI. Existing terminals were left unchanged.',
      );
    }
    if (session.workspace_mode && input.workspaceMode && session.workspace_mode !== input.workspaceMode) {
      throw new ApiError(
        409,
        'workspace_mode_mismatch',
        'The selected workspace mode does not match this session.',
      );
    }
    if (!session.workspace_mode && !inferredLegacyMode && existing.length > 0) {
      if (!requestedWorkspaceMode) {
        throw new ApiError(
          409,
          'workspace_mode_required',
          'Choose Shared Folder or Isolated Worktrees before adding a terminal to this saved session. Existing terminals were left unchanged.',
        );
      }
      if (workspaceRows.length > 0 && requestedWorkspaceMode !== 'isolated') {
        throw new ApiError(
          409,
          'workspace_mode_required',
          'This saved session has ambiguous workspace paths. Choose Isolated Worktrees only if every existing terminal already has a recorded worktree; existing paths will not be changed.',
        );
      }
      if (workspaceRows.length === 0 && requestedWorkspaceMode === 'isolated') {
        throw new ApiError(
          409,
          'workspace_mode_incompatible',
          'Existing terminals do not have isolated worktrees. Choose Shared Folder to add a CLI without changing their working directories.',
        );
      }
    }

    assertSharedFolderSafety(sessionWorkspaceMode, existing.length + 1, [
      ...existing.map((terminal) => ({ description: terminal.task_description ?? '' })),
      newTask,
    ]);

    if (
      sessionWorkspaceMode === 'shared' &&
      workspaceRows.length > 0
    ) {
      throw new ApiError(
        409,
        'workspace_mode_incompatible',
        'This session has existing isolated terminal paths. Shared Folder cannot be applied without moving those terminals, so they were left unchanged.',
      );
    }

    if (sessionWorkspaceMode === 'shared') {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO session_terminals
               (id, session_id, tool_profile_id, process_status, restart_count)
             VALUES (?, ?, ?, 'starting', 0)`,
          )
          .run(terminalId, sessionId, tool.id);
        insertAgentTask(this.db, sessionId, terminalId, newTask, new Date().toISOString());
      })();

      try {
        await this.manager.start({
          terminalId,
          sessionId,
          file: tool.command,
          args: tool.fixedArgs,
          cwd,
        });
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'start_failed';
        const message =
          error instanceof ApiError ? error.message : 'The terminal could not be started.';
        terminalWrite(this.db, terminalId, 'error', code, message);
        refreshSessionStatus(this.db, sessionId);
      }

      const terminalState = this.db
        .prepare('SELECT process_status, error_code, last_error FROM session_terminals WHERE id = ?')
        .get(terminalId) as
        | { process_status: string; error_code: string | null; last_error: string | null }
        | undefined;
      if (terminalState?.process_status === 'error') {
        this.db.prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?').run(terminalId);
        this.db.prepare('DELETE FROM agent_tasks WHERE terminal_id = ?').run(terminalId);
        this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(terminalId);
        refreshSessionStatus(this.db, sessionId);
        throw new ApiError(
          409,
          terminalState.error_code ?? 'start_failed',
          terminalState.last_error ?? 'The terminal could not be started.',
        );
      }
      this.db
        .prepare('UPDATE sessions SET workspace_mode = ?, updated_at = ? WHERE id = ?')
        .run(sessionWorkspaceMode, new Date().toISOString(), sessionId);
      return this.get(sessionId);
    }

    const runtimeDir = requireWorkspaceRoot(this.runtimeDir);
    let repository: GitRepositorySnapshot | null = null;
    const workspacePlans: Array<{
      terminalId: string;
      ownerToolProfileId: string;
      branchName: string;
      worktreePath: string;
      workingDirectory: string;
    }> = [];

    if (workspaceRows.length === 0) {
      repository = await inspectGitRepository(cwd);
    } else {
      const workspaces = workspaceRows.map((terminal) => {
        if (
          terminal.workspace_status !== 'ready' ||
          !terminal.workspace_repository_root ||
          !terminal.workspace_base_commit ||
          !terminal.workspace_path ||
          !terminal.workspace_working_directory
        ) {
          throw new ApiError(
            409,
            'git_workspace_unavailable',
            'Every existing isolated worktree must be ready before another can be added.',
          );
        }
        return terminal;
      });
      if (workspaceRows.length !== existing.length) {
        throw new ApiError(
          409,
          'workspace_mode_incompatible',
          'This saved session mixes terminals with and without recorded worktrees. Existing working directories were left unchanged, so another isolated terminal cannot be added safely.',
        );
      }
      const source = workspaces[0]!;
      repository = {
        repositoryRoot: source.workspace_repository_root!,
        baseCommit: source.workspace_base_commit!,
        projectRelativePath: path.relative(source.workspace_repository_root!, cwd),
      };
      for (const terminal of workspaces) {
        await validateGitWorkspace(
          terminal.workspace_path!,
          terminal.workspace_working_directory!,
        );
      }
    }

    const newWorkspace = repository
      ? {
          terminalId,
          ownerToolProfileId: tool.id,
          branchName: getGitBranchName(sessionId, terminalId),
          ...getGitWorkspacePaths(runtimeDir, repository, sessionId, terminalId),
        }
      : null;
    if (newWorkspace) workspacePlans.push(newWorkspace);

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO session_terminals
             (id, session_id, tool_profile_id, process_status, restart_count)
           VALUES (?, ?, ?, 'starting', 0)`,
        )
        .run(terminalId, sessionId, tool.id);
      insertAgentTask(this.db, sessionId, terminalId, newTask, now);

      if (repository) {
        const insertWorkspace = this.db.prepare(
          `INSERT INTO agent_workspaces (
             terminal_id, owner_tool_profile_id, task_title, repository_root,
             worktree_path, working_directory, base_commit, status,
             last_error, created_at, updated_at, branch_name
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?, ?)`,
        );
        for (const plan of workspacePlans) {
          insertWorkspace.run(
            plan.terminalId,
            plan.ownerToolProfileId,
            newTask.description || session.title,
            repository.repositoryRoot,
            plan.worktreePath,
            plan.workingDirectory,
            repository.baseCommit,
            now,
            now,
            plan.branchName,
          );
        }
      }
    })();

    let workspaceFailure = false;
    const createdWorktreePaths: string[] = [];
    let workspaceFailureError: ApiError | null = null;
    if (repository) {
      for (const plan of workspacePlans) {
        const pathExisted = fs.existsSync(plan.worktreePath);
        try {
          await createGitWorktree(repository, plan.worktreePath, plan.branchName);
          createdWorktreePaths.push(plan.worktreePath);
          this.db
            .prepare(
              `UPDATE agent_workspaces
               SET status = 'ready', last_error = NULL, updated_at = ?
               WHERE terminal_id = ?`,
            )
            .run(new Date().toISOString(), plan.terminalId);
        } catch (error) {
          workspaceFailure = true;
          const message =
            error instanceof ApiError
              ? error.message
              : 'The isolated Git workspace could not be created.';
          workspaceFailureError ??= error instanceof ApiError
            ? error
            : new ApiError(409, 'workspace_provision_failed', message);
          if (!pathExisted && fs.existsSync(plan.worktreePath)) {
            createdWorktreePaths.push(plan.worktreePath);
          }
          this.db
            .prepare(
              `UPDATE agent_workspaces
               SET status = 'failed', last_error = ?, updated_at = ?
               WHERE terminal_id = ?`,
            )
            .run(message, new Date().toISOString(), plan.terminalId);
          if (plan.terminalId === terminalId) {
            terminalWrite(
              this.db,
              terminalId,
              'error',
              'workspace_provision_failed',
              message,
            );
          }
        }
      }
    }

    if (workspaceFailure) {
      let cleanupFailed = false;
      for (const worktreePath of createdWorktreePaths) {
        try {
          await removeGitWorktree(repository!.repositoryRoot, worktreePath);
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        this.db
          .prepare(
            `UPDATE agent_workspaces
             SET status = 'failed', last_error = ?, updated_at = ?
             WHERE terminal_id = ?`,
          )
          .run(
            'Worktree cleanup failed; inspect this path before retrying.',
            new Date().toISOString(),
            terminalId,
          );
        terminalWrite(
          this.db,
          terminalId,
          'error',
          'workspace_cleanup_failed',
          'The new isolated workspace failed and could not be cleaned up.',
        );
        refreshSessionStatus(this.db, sessionId);
        throw new ApiError(
          409,
          'workspace_cleanup_failed',
          'The new isolated workspace failed and its worktree could not be cleaned up.',
        );
      }
      this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(terminalId);
      refreshSessionStatus(this.db, sessionId);
      throw workspaceFailureError ?? new ApiError(
        409,
        'workspace_provision_failed',
        'The isolated Git workspace could not be created.',
      );
    }

    if (newTask.dependencies.length > 0) {
      this.db
        .prepare('UPDATE sessions SET workspace_mode = ?, updated_at = ? WHERE id = ?')
        .run(sessionWorkspaceMode, new Date().toISOString(), sessionId);
      terminalWrite(
        this.db,
        terminalId,
        'stopped',
        'awaiting_dependencies',
        'Waiting for dependency tasks to be integrated.',
      );
      refreshSessionStatus(this.db, sessionId);
      return this.get(sessionId);
    }

    if (repository) {
      const lease = acquireCreationLease(this.db, {
        taskId: terminalId,
        sessionId,
        projectId: session.project_id,
        terminalId,
        toolProfileId: tool.id,
        repositoryRoot: repository.repositoryRoot,
        scopes: newTask.declaredFileScope,
      });
      if (!lease.ok) {
        this.db
          .prepare('UPDATE sessions SET workspace_mode = ?, updated_at = ? WHERE id = ?')
          .run(sessionWorkspaceMode, new Date().toISOString(), sessionId);
        markTaskWaitingForFiles(this.db, terminalId, lease.reason!);
        terminalWrite(this.db, terminalId, 'stopped', 'awaiting_files', lease.reason);
        refreshSessionStatus(this.db, sessionId);
        return this.get(sessionId);
      }
    }

    try {
      await this.manager.start({
        terminalId,
        sessionId,
        file: tool.command,
        args: tool.fixedArgs,
        cwd: newWorkspace?.workingDirectory ?? cwd,
      });
      writeTaskState(this.db, terminalId, 'running');
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'start_failed';
      const message =
        error instanceof ApiError ? error.message : 'The terminal could not be started.';
      terminalWrite(this.db, terminalId, 'error', code, message);
      refreshSessionStatus(this.db, sessionId);
    }

    const terminalState = this.db
      .prepare('SELECT process_status, error_code, last_error FROM session_terminals WHERE id = ?')
      .get(terminalId) as
      | { process_status: string; error_code: string | null; last_error: string | null }
      | undefined;
    if (terminalState?.process_status === 'error') {
      if (newWorkspace) {
        try {
          await removeGitWorktree(repository!.repositoryRoot, newWorkspace.worktreePath);
          this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(terminalId);
        } catch {
          this.db
            .prepare(
              `UPDATE agent_workspaces
               SET status = 'failed', last_error = ?, updated_at = ?
               WHERE terminal_id = ?`,
            )
            .run('Worktree cleanup failed; inspect this path before retrying.', new Date().toISOString(), terminalId);
        }
      } else {
        this.db.prepare('DELETE FROM session_terminals WHERE id = ?').run(terminalId);
      }
      this.db.prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?').run(terminalId);
      this.db.prepare('DELETE FROM agent_tasks WHERE terminal_id = ?').run(terminalId);
      refreshSessionStatus(this.db, sessionId);
      throw new ApiError(
        409,
        terminalState.error_code ?? 'start_failed',
        terminalState.last_error ?? 'The terminal could not be started.',
      );
    }
    this.db
      .prepare('UPDATE sessions SET workspace_mode = ?, updated_at = ? WHERE id = ?')
      .run(sessionWorkspaceMode, new Date().toISOString(), sessionId);

    return this.get(sessionId);
  }

  /**
   * Explicitly converts a stopped shared-folder session into isolated Git
   * worktrees. Files in the shared folder are never moved or deleted, and a
   * dirty or unsupported repository is rejected with the exact reason.
   */
  async isolateSession(sessionId: string): Promise<SessionSummary> {
    const session = getSessionRow(this.db, sessionId);
    const terminals = getTerminalRows(this.db, sessionId);
    if (session.workspace_mode === 'isolated') return this.get(sessionId);
    if (terminals.length === 0) {
      throw new ApiError(
        409,
        'session_has_no_terminals',
        'Add at least one CLI before converting this session to isolated worktrees.',
      );
    }
    if (
      terminals.some(
        (terminal) =>
          this.manager.hasLive(terminal.id) ||
          terminal.process_status === 'starting' ||
          terminal.process_status === 'running',
      )
    ) {
      throw new ApiError(
        409,
        'session_must_be_stopped',
        'Stop every terminal in this session before converting it to isolated worktrees. Existing processes, folders, and files were left unchanged.',
      );
    }
    if (terminals.some((terminal) => terminal.workspace_status !== null)) {
      throw new ApiError(
        409,
        'workspace_mode_incompatible',
        'This session already records worktree paths, so it cannot be converted again.',
      );
    }

    const project = getProjectLaunchRow(this.db, session.project_id);
    const cwd = await ensureProjectLaunchable(project);
    const repository = await inspectGitRepository(cwd);
    const runtimeDir = requireWorkspaceRoot(this.runtimeDir);
    const plans = terminals.map((terminal) => ({
      terminalId: terminal.id,
      ownerToolProfileId: terminal.tool_profile_id,
      taskTitle: terminal.task_description?.trim() || session.title,
      branchName: getGitBranchName(sessionId, terminal.id),
      ...getGitWorkspacePaths(runtimeDir, repository, sessionId, terminal.id),
    }));
    const now = new Date().toISOString();

    this.db.transaction(() => {
      const insertWorkspace = this.db.prepare(
        `INSERT INTO agent_workspaces (
           terminal_id, owner_tool_profile_id, task_title, repository_root,
           worktree_path, working_directory, base_commit, status,
           last_error, created_at, updated_at, branch_name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', NULL, ?, ?, ?)`,
      );
      for (const plan of plans) {
        insertWorkspace.run(
          plan.terminalId,
          plan.ownerToolProfileId,
          plan.taskTitle,
          repository.repositoryRoot,
          plan.worktreePath,
          plan.workingDirectory,
          repository.baseCommit,
          now,
          now,
          plan.branchName,
        );
      }
    })();

    const createdWorktreePaths: string[] = [];
    try {
      for (const plan of plans) {
        await createGitWorktree(repository, plan.worktreePath, plan.branchName);
        createdWorktreePaths.push(plan.worktreePath);
        this.db
          .prepare(
            `UPDATE agent_workspaces SET status = 'ready', last_error = NULL, updated_at = ?
             WHERE terminal_id = ?`,
          )
          .run(new Date().toISOString(), plan.terminalId);
      }
    } catch (error) {
      for (const worktreePath of createdWorktreePaths) {
        try {
          await removeGitWorktree(repository.repositoryRoot, worktreePath);
        } catch {
          // Leave the worktree for manual inspection rather than forcing removal.
        }
      }
      this.db.transaction(() => {
        for (const plan of plans) {
          this.db
            .prepare('DELETE FROM agent_workspaces WHERE terminal_id = ?')
            .run(plan.terminalId);
        }
      })();
      throw error instanceof ApiError
        ? error
        : new ApiError(
            409,
            'workspace_provision_failed',
            'The session could not be converted to isolated worktrees. Nothing in the shared folder was moved or deleted.',
          );
    }

    this.db
      .prepare('UPDATE sessions SET workspace_mode = ?, updated_at = ? WHERE id = ?')
      .run('isolated', now, sessionId);
    return this.get(sessionId);
  }

  async restartTerminal(
    terminalId: string,
    expectedSessionId?: string,
  ): Promise<SessionSummary> {
    const context = await this.getTerminalContext(terminalId, expectedSessionId);
    await ensureProjectLaunchable(context.project);
    if (context.workspace) await ensureWorkspaceLaunchable(context.workspace);
    await ensureToolLaunchable(context.tool.id, this.db);

    await this.manager.restart(terminalId, async () => {
      const current = await this.getTerminalContext(terminalId, expectedSessionId);
      const currentProjectCwd = await ensureProjectLaunchable(current.project);
      const currentWorkspaceCwd = current.workspace
        ? await ensureWorkspaceLaunchable(current.workspace)
        : null;
      const tool = await ensureToolLaunchable(current.tool.id, this.db);
      return {
        terminalId,
        sessionId: current.sessionId,
        file: tool.command,
        args: tool.fixedArgs,
        cwd: currentWorkspaceCwd ?? currentProjectCwd,
      };
    });
    this.db
      .prepare(
        `UPDATE agent_tasks SET state = 'running', blocked_reason = NULL, updated_at = ?
         WHERE terminal_id = ? AND state IN ('ready', 'blocked', 'failed')`,
      )
      .run(new Date().toISOString(), terminalId);

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
                p.path_key AS project_path_key,
                aw.owner_tool_profile_id AS workspace_owner_tool_profile_id,
                aw.task_title AS workspace_task_title,
                aw.repository_root AS workspace_repository_root,
                aw.worktree_path AS workspace_path,
                aw.working_directory AS workspace_working_directory,
                aw.base_commit AS workspace_base_commit,
                aw.branch_name AS workspace_branch_name,
                aw.status AS workspace_status,
                aw.last_error AS workspace_error
         FROM session_terminals st
         JOIN sessions s ON s.id = st.session_id
         JOIN projects p ON p.id = s.project_id
         LEFT JOIN agent_workspaces aw ON aw.terminal_id = st.id
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
          workspace_owner_tool_profile_id: string | null;
          workspace_task_title: string | null;
          workspace_repository_root: string | null;
          workspace_path: string | null;
          workspace_working_directory: string | null;
          workspace_base_commit: string | null;
          workspace_branch_name: string | null;
          workspace_status: AgentWorkspaceSummary['status'] | null;
          workspace_error: string | null;
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
      workspace:
        row.workspace_status &&
        row.workspace_owner_tool_profile_id &&
        row.workspace_task_title &&
        row.workspace_repository_root &&
        row.workspace_path &&
        row.workspace_working_directory &&
        row.workspace_base_commit
          ? {
              ownerToolProfileId: row.workspace_owner_tool_profile_id,
              taskTitle: row.workspace_task_title,
              repositoryRoot: row.workspace_repository_root,
              path: row.workspace_path,
              workingDirectory: row.workspace_working_directory,
              baseCommit: row.workspace_base_commit,
              branchName: row.workspace_branch_name,
              status: row.workspace_status,
              error: row.workspace_error,
            }
          : null,
    };
  }
}

async function ensureWorkspaceLaunchable(
  workspace: AgentWorkspaceSummary,
): Promise<string> {
  if (workspace.status !== 'ready') {
    throw new ApiError(
      409,
      'git_workspace_unavailable',
      workspace.error ?? 'The isolated Git workspace is not ready.',
    );
  }
  await validateGitWorkspace(workspace.path, workspace.workingDirectory);
  return workspace.workingDirectory;
}
