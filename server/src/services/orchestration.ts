import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActiveLeaseSummary,
  AgentTaskState,
  AgentTaskSummary,
  OrchestrationCapacity,
  OrchestrationSettings,
  SessionOrchestrationSummary,
  TaskIntegrationAttempt,
  TaskValidationResult,
  ValidationCommandConfig,
  WorkflowPlanSummary,
  WorkflowSummary,
  WorkspaceMode,
} from '../../../shared/api-types.cjs';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import {
  DEFAULT_MAX_CONCURRENT_AGENTS,
  MAX_CONCURRENT_AGENTS,
} from '../limits';
import {
  addDetachedWorktree,
  checkMerge,
  countCommitsBetween,
  createBranchIfMissing,
  createMergeCommit,
  currentBranch,
  deleteGitBranch,
  fastForwardWorktree,
  headCommit,
  isAncestor,
  isBranchCheckedOut,
  readCommittedChanges,
  readWorktreeChanges,
  requireCommit,
  resolveCommitOrNull,
  updateBranchRef,
  validateBranchName,
} from './gitReview';
import { removeGitWorktree, validateGitWorkspace } from './gitWorkspaces';
import {
  FileLeaseService,
  normalizeLeasePath,
  resolveScopeEntries,
  type LeaseConflict,
  type ScopeEntry,
} from './fileLeases';
import type { SessionService } from './sessions';
import {
  ACTIVE_TASK_STATES,
  deriveQueuedState,
  findProtectedViolations,
  findScopeViolations,
  normalizeRepoPath,
  type TaskDependencyView,
} from './taskPolicy';
import {
  normalizeProtectedPaths,
  normalizeValidationCommands,
  ValidationExecutor,
} from './validation';

export const DEFAULT_INTEGRATION_BRANCH = 'devpilot/integration';

const VALIDATION_WORKTREES_DIRECTORY = 'validation-worktrees';
const MAX_COMPLETION_SUMMARY_LENGTH = 4000;
const MAX_ACTUAL_FILES = 500;

interface TaskRow {
  id: string;
  session_id: string;
  terminal_id: string;
  description: string;
  declared_file_scope_json: string;
  dependencies_json: string;
  status: string;
  state: AgentTaskState;
  blocked_reason: string | null;
  completion_summary: string | null;
  completed_at: string | null;
  assigned_at: string | null;
  actual_files_json: string;
  scope_violations_json: string;
  changed_files_json: string;
  validation_status: AgentTaskSummary['validationStatus'];
  validation_summary: string | null;
  integration_status: AgentTaskSummary['integrationStatus'];
  integration_reason: string | null;
  integration_commit: string | null;
  target_branch: string | null;
  wait_kind: 'dependency' | 'files' | null;
  deferred_scope_json: string;
  replan_count: number;
  process_status: string;
  tool_profile_id: string;
  tool_name: string;
  project_id: string;
  project_name: string;
  workspace_mode: WorkspaceMode | null;
  ws_status: string | null;
  ws_worktree_path: string | null;
  ws_working_directory: string | null;
  ws_branch_name: string | null;
  ws_repository_root: string | null;
  ws_base_commit: string | null;
  ws_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  project_id: string;
  auto_integrate: number;
  scheduling_paused: number;
  max_concurrent_agents: number;
  target_branch: string | null;
  protected_paths_json: string;
  validation_commands_json: string;
  updated_at: string;
}

interface ValidationRow {
  id: string;
  task_id: string;
  attempt: number;
  phase: TaskValidationResult['phase'];
  name: string;
  command: string;
  args_json: string;
  status: TaskValidationResult['status'];
  exit_code: number | null;
  duration_ms: number | null;
  output: string;
  started_at: string;
  finished_at: string | null;
}

interface IntegrationRow {
  id: string;
  task_id: string;
  state: TaskIntegrationAttempt['state'];
  target_branch: string;
  source_branch: string;
  source_commit: string | null;
  target_commit_before: string | null;
  merge_commit: string | null;
  candidate_commit: string | null;
  validation_summary: string | null;
  changed_files_json: string;
  violations_json: string;
  reason: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
}

interface IntegrationReview {
  ok: boolean;
  code: string;
  blockers: string[];
  changedFiles: string[];
  violations: string[];
  sourceCommit: string | null;
  targetCommit: string | null;
  targetBranch: string;
}

interface TaskWorkspace {
  repositoryRoot: string;
  worktreePath: string;
  workingDirectory: string;
  branchName: string;
  baseCommit: string;
}

export interface OrchestrationOptions {
  db: Db;
  sessions: SessionService;
  maxConcurrentAgents?: number;
  maxLiveTerminals?: number;
  /** Root for isolated combined-candidate validation worktrees. */
  runtimeDir?: string;
  /** Maximum time a scheduling tick may run before it is considered hung. */
  schedulerTickTimeoutMs?: number;
}

export interface CandidateValidationResult {
  ok: boolean;
  summary: string;
  reason: string | null;
}

export interface IntegrationOptions {
  acknowledgeNoValidation?: boolean;
  allowOutOfScope?: boolean;
}

export interface ScheduleResult {
  scheduled: string[];
  skipped: Array<{ taskId: string; reason: string }>;
}

const TASK_SELECT = `
  SELECT at.id, at.session_id, at.terminal_id, at.description,
         at.declared_file_scope_json, at.dependencies_json, at.status,
         at.state, at.blocked_reason, at.completion_summary, at.completed_at,
         at.assigned_at, at.actual_files_json, at.scope_violations_json,
         at.changed_files_json, at.validation_status, at.validation_summary,
         at.integration_status, at.integration_reason, at.integration_commit,
         at.target_branch, at.wait_kind, at.deferred_scope_json, at.replan_count,
         at.created_at, at.updated_at,
         st.process_status, st.tool_profile_id,
         tp.display_name AS tool_name,
         s.project_id, s.workspace_mode,
         p.name AS project_name,
         aw.status AS ws_status,
         aw.worktree_path AS ws_worktree_path,
         aw.working_directory AS ws_working_directory,
         aw.branch_name AS ws_branch_name,
         aw.repository_root AS ws_repository_root,
         aw.base_commit AS ws_base_commit,
         aw.last_error AS ws_error
  FROM agent_tasks at
  JOIN session_terminals st ON st.id = at.terminal_id
  JOIN sessions s ON s.id = at.session_id
  JOIN projects p ON p.id = s.project_id
  JOIN tool_profiles tp ON tp.id = st.tool_profile_id
  LEFT JOIN agent_workspaces aw ON aw.terminal_id = at.terminal_id
`;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mapTaskRow(
  row: TaskRow,
  state: AgentTaskState,
  blockedReason: string | null,
  leases: AgentTaskSummary['leases'] = [],
): AgentTaskSummary {
  return {
    id: row.id,
    description: row.description,
    declaredFileScope: parseJsonArray(row.declared_file_scope_json),
    dependencies: parseJsonArray(row.dependencies_json),
    status: row.status as AgentTaskSummary['status'],
    state,
    blockedReason,
    changedFiles: parseJsonArray(row.changed_files_json),
    actualFiles: parseJsonArray(row.actual_files_json),
    scopeViolations: parseJsonArray(row.scope_violations_json),
    validationStatus: row.validation_status,
    validationSummary: row.validation_summary,
    integrationStatus: row.integration_status,
    integrationReason: row.integration_reason,
    integrationCommit: row.integration_commit,
    targetBranch: row.target_branch,
    branchName: row.ws_branch_name,
    worktreePath: row.ws_worktree_path,
    completionSummary: row.completion_summary,
    completedAt: row.completed_at,
    waitKind: row.wait_kind ?? null,
    deferredScope: parseJsonArray(row.deferred_scope_json),
    replanCount: Number(row.replan_count ?? 0),
    agentToolId: row.tool_profile_id,
    agentName: row.tool_name,
    leases,
  };
}

function mapValidationRow(row: ValidationRow): TaskValidationResult {
  return {
    id: row.id,
    taskId: row.task_id,
    attempt: Number(row.attempt),
    phase: row.phase ?? 'task',
    name: row.name,
    command: row.command,
    args: parseJsonArray(row.args_json),
    status: row.status,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    output: row.output,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapIntegrationRow(row: IntegrationRow): TaskIntegrationAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    state: row.state,
    targetBranch: row.target_branch,
    sourceBranch: row.source_branch,
    sourceCommit: row.source_commit,
    targetCommitBefore: row.target_commit_before,
    mergeCommit: row.merge_commit,
    candidateCommit: row.candidate_commit ?? null,
    validationSummary: row.validation_summary ?? null,
    changedFiles: parseJsonArray(row.changed_files_json),
    violations: parseJsonArray(row.violations_json),
    reason: row.reason,
    attempt: Number(row.attempt),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function settingsToSummary(
  projectId: string,
  row: SettingsRow | undefined,
  systemMax: number,
): OrchestrationSettings {
  return {
    projectId,
    autoIntegrate: row ? row.auto_integrate === 1 : false,
    schedulingPaused: row ? row.scheduling_paused === 1 : false,
    maxConcurrentAgents: row ? Math.min(Number(row.max_concurrent_agents), systemMax) : Math.min(DEFAULT_MAX_CONCURRENT_AGENTS, systemMax),
    systemMaxConcurrentAgents: systemMax,
    targetBranch: row?.target_branch ?? null,
    resolvedTargetBranch: row?.target_branch ?? DEFAULT_INTEGRATION_BRANCH,
    validationCommands: row
      ? (JSON.parse(row.validation_commands_json) as ValidationCommandConfig[])
      : [],
    protectedPaths: row ? parseJsonArray(row.protected_paths_json) : [],
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Owns the task lifecycle: readiness/dependency scheduling, completion
 * evidence, the validation pipeline and the sequential integration queue.
 *
 * Task completion is never inferred from a CLI process starting or exiting.
 * The supported completion signal is an explicit report from the user or
 * agent, backed by at least one commit on the task branch and a clean
 * worktree, followed by the configured validation commands.
 */
export class OrchestrationService {
  private readonly db: Db;
  private readonly sessions: SessionService;
  private readonly systemMaxConcurrentAgents: number;
  private readonly maxLiveTerminals: number;
  private readonly runtimeDir: string | null;
  private readonly leases: FileLeaseService;
  private readonly executor = new ValidationExecutor();
  private tickChain: Promise<unknown> = Promise.resolve();
  private queueChain: Promise<unknown> = Promise.resolve();
  private readonly tickTimeoutMs: number;

  constructor(options: OrchestrationOptions) {
    this.db = options.db;
    this.sessions = options.sessions;
    this.systemMaxConcurrentAgents = Math.max(
      1,
      Math.min(options.maxConcurrentAgents ?? DEFAULT_MAX_CONCURRENT_AGENTS, MAX_CONCURRENT_AGENTS),
    );
    this.maxLiveTerminals = options.maxLiveTerminals ?? this.sessions.maxLiveTerminals;
    this.runtimeDir = options.runtimeDir ?? null;
    this.tickTimeoutMs = options.schedulerTickTimeoutMs ?? 30000;
    this.leases = new FileLeaseService(this.db);
  }

  close(): void {
    // Active process trees are owned by the ProcessManager shutdown path.
  }

  getSettings(projectId: string): OrchestrationSettings {
    this.requireProject(projectId);
    const row = this.db
      .prepare('SELECT * FROM project_orchestration_settings WHERE project_id = ?')
      .get(projectId) as SettingsRow | undefined;
    return settingsToSummary(projectId, row, this.systemMaxConcurrentAgents);
  }

  updateSettings(
    projectId: string,
    input: {
      autoIntegrate?: boolean;
      schedulingPaused?: boolean;
      maxConcurrentAgents?: number;
      targetBranch?: string | null;
      validationCommands?: unknown;
      protectedPaths?: unknown;
    },
  ): OrchestrationSettings {
    const project = this.requireProject(projectId);
    const current = this.getSettings(projectId);

    const autoIntegrate = input.autoIntegrate ?? current.autoIntegrate;
    const schedulingPaused = input.schedulingPaused ?? current.schedulingPaused;
    const maxConcurrentAgents = input.maxConcurrentAgents ?? current.maxConcurrentAgents;
    if (
      !Number.isInteger(maxConcurrentAgents) ||
      maxConcurrentAgents < 1 ||
      maxConcurrentAgents > this.systemMaxConcurrentAgents
    ) {
      throw new ApiError(
        400,
        'concurrency_limit_invalid',
        `Concurrent agents must be a whole number between 1 and ${this.systemMaxConcurrentAgents} for this backend.`,
      );
    }

    let targetBranch: string | null = current.targetBranch;
    if (input.targetBranch !== undefined) {
      if (input.targetBranch === null || input.targetBranch.trim() === '') {
        targetBranch = null;
      } else {
        targetBranch = input.targetBranch.trim();
        this.validateTargetBranchName(project.path, targetBranch);
      }
    }

    const validationCommands =
      input.validationCommands === undefined
        ? current.validationCommands
        : normalizeValidationCommands(input.validationCommands);
    const protectedPaths =
      input.protectedPaths === undefined
        ? current.protectedPaths
        : normalizeProtectedPaths(input.protectedPaths);

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO project_orchestration_settings (
           project_id, auto_integrate, scheduling_paused, max_concurrent_agents,
           target_branch, protected_paths_json, validation_commands_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           auto_integrate = excluded.auto_integrate,
           scheduling_paused = excluded.scheduling_paused,
           max_concurrent_agents = excluded.max_concurrent_agents,
           target_branch = excluded.target_branch,
           protected_paths_json = excluded.protected_paths_json,
           validation_commands_json = excluded.validation_commands_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        projectId,
        autoIntegrate ? 1 : 0,
        schedulingPaused ? 1 : 0,
        maxConcurrentAgents,
        targetBranch,
        JSON.stringify(protectedPaths),
        JSON.stringify(validationCommands),
        now,
      );

    return this.getSettings(projectId);
  }

  capacity(projectId: string): OrchestrationCapacity {
    const settings = this.getSettings(projectId);
    const activeAgents = this.countActiveAgents();
    const liveTerminals = this.sessions.liveTerminalCount;
    const projectCap = settings.maxConcurrentAgents;
    const slotsByAgents = Math.max(0, Math.min(projectCap, this.systemMaxConcurrentAgents) - activeAgents);
    const slotsByProcesses = Math.max(0, this.maxLiveTerminals - liveTerminals);
    return {
      maxConcurrentAgents: Math.min(projectCap, this.systemMaxConcurrentAgents),
      systemMaxConcurrentAgents: this.systemMaxConcurrentAgents,
      activeAgents,
      maxLiveTerminals: this.maxLiveTerminals,
      liveTerminals,
      availableSlots: Math.min(slotsByAgents, slotsByProcesses),
    };
  }

  summarizeSession(sessionId: string): SessionOrchestrationSummary {
    const session = this.db
      .prepare('SELECT id, project_id, workspace_mode FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { id: string; project_id: string; workspace_mode: WorkspaceMode | null }
      | undefined;
    if (!session) throw new ApiError(404, 'session_not_found', 'Session not found.');

    const tasks = this.listTasks({ sessionId });
    const terminalCount = (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM session_terminals WHERE session_id = ?')
        .get(sessionId) as { count: number }
    ).count;

    const settings = this.getSettings(session.project_id);
    return {
      sessionId,
      workspaceMode: session.workspace_mode,
      settings,
      capacity: this.capacity(session.project_id),
      tasks,
      sharedFolderRisk: session.workspace_mode === 'shared' && Number(terminalCount) > 1,
      schedulingPaused: settings.schedulingPaused,
      workflow: this.workflowSummary(sessionId),
      // Ownership is reported for this session's tasks; the project-wide view
      // (other sessions waiting on the same files) is visible through their own
      // summaries and through each blocking task's wait reason.
      leases: this.leasesForSession(session.project_id, sessionId),
      waiting: tasks
        .filter((task) => task.state === 'blocked' && task.waitKind !== null)
        .map((task) => ({
          taskId: task.id,
          kind: task.waitKind!,
          reason: task.blockedReason ?? 'Waiting for coordination.',
        })),
    };
  }

  listTasks(filter: { sessionId?: string; projectId?: string } = {}): AgentTaskSummary[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.sessionId) {
      where.push('at.session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.projectId) {
      where.push('s.project_id = ?');
      params.push(filter.projectId);
    }
    const rows = this.withDerivedStates(
      this.db
        .prepare(
          `${TASK_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
           ORDER BY at.created_at, at.id`,
        )
        .all(...params) as TaskRow[],
    );
    return rows.map(([row, state, reason]) =>
      mapTaskRow(row, state, reason, this.taskLeases(row.id)),
    );
  }

  getTask(taskId: string): AgentTaskSummary {
    const rows = this.withDerivedStates(
      this.db.prepare(`${TASK_SELECT} WHERE at.id = ?`).all(taskId) as TaskRow[],
    );
    if (rows.length === 0) throw new ApiError(404, 'task_not_found', 'Task not found.');
    const [row, state, reason] = rows[0]!;
    return mapTaskRow(row, state, reason, this.taskLeases(row.id));
  }

  /**
   * Sends a task's description directly to a live terminal's stdin.
   * This is the "Send to terminal" feature — lets the user route a task
   * to one of their already-open CLI terminals instead of the workflow
   * spawning a new agent.
   */
  async sendTaskToTerminal(
    taskId: string,
    terminalId: string,
  ): Promise<{ sent: boolean; terminalId: string; taskId: string }> {
    const task = this.getTask(taskId);
    const description = task.description?.trim();
    if (!description) {
      throw new ApiError(400, 'task_no_description', 'This task has no description to send.');
    }
    if (!this.sessions.hasLiveTerminal(terminalId)) {
      throw new ApiError(
        409,
        'terminal_not_running',
        'The selected terminal is not running. Start it first.',
      );
    }
    this.sessions.sendTextToTerminal(terminalId, description + '\r');
    return { sent: true, terminalId, taskId };
  }

  private taskLeases(taskId: string): AgentTaskSummary['leases'] {
    return this.leases.activeForTask(taskId).map((lease) => ({
      path: lease.path,
      isDirectory: lease.is_directory === 1,
      acquiredAt: lease.acquired_at,
      reason: lease.reason,
    }));
  }

  private leasesForSession(projectId: string, sessionId: string): ActiveLeaseSummary[] {
    return this.leases.summarize(projectId, sessionId).map((lease) => ({
      taskId: lease.taskId,
      taskLabel: lease.taskLabel,
      taskState: lease.taskState as AgentTaskState,
      agentToolId: lease.agentToolId,
      agentName: lease.agentName,
      path: lease.path,
      isDirectory: lease.isDirectory,
      reason: lease.reason,
      acquiredAt: lease.acquiredAt,
    }));
  }

  private workflowSummary(sessionId: string): WorkflowSummary | null {
    const row = this.db
      .prepare('SELECT * FROM workflow_runs WHERE session_id = ?')
      .get(sessionId) as
      | {
          id: string;
          project_id: string;
          session_id: string;
          prompt: string;
          plan_json: string;
          status: WorkflowSummary['status'];
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    let plan: WorkflowPlanSummary = { summary: '', conventions: [], tasks: [] };
    try {
      plan = JSON.parse(row.plan_json) as WorkflowPlanSummary;
    } catch {
      // A malformed stored plan is shown as empty rather than breaking the panel.
    }
    return {
      id: row.id,
      projectId: row.project_id,
      sessionId: row.session_id,
      prompt: row.prompt,
      status: row.status,
      plan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Marks live, assigned tasks as running so the UI reflects the backend state.
   * Also demotes tasks whose CLI process died to 'interrupted' so leases are released. */
  syncRunningStates(): number {
    const now = new Date().toISOString();
    const demoted = this.db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'interrupted',
             blocked_reason = 'The agent CLI process died before the task was completed. Task worktree is preserved for recovery.',
             updated_at = ?
         WHERE state IN ('assigned', 'running')
           AND EXISTS (
             SELECT 1 FROM session_terminals st
             WHERE st.id = agent_tasks.terminal_id
               AND st.process_status NOT IN ('starting', 'running')
               AND st.started_at < datetime('now', '-5 seconds')
           )`,
      )
      .run(now).changes;
    const promoted = this.db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'running', blocked_reason = NULL, updated_at = ?
         WHERE state IN ('ready', 'blocked', 'assigned')
           AND EXISTS (
             SELECT 1 FROM session_terminals st
             WHERE st.id = agent_tasks.terminal_id
               AND st.process_status IN ('starting', 'running')
           )`,
      )
      .run(now).changes;
    return demoted + promoted;
  }

  scheduleSession(sessionId: string): Promise<ScheduleResult> {
    return this.serializeTick(() => this.claimAndLaunch({ sessionId }));
  }

  scheduleAll(): Promise<ScheduleResult> {
    return this.serializeTick(() => this.claimAndLaunch({}));
  }

  async completeTask(
    taskId: string,
    input: { summary: string },
  ): Promise<AgentTaskSummary> {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'This task is already integrated.');
    }
    if (!task.description.trim()) {
      throw new ApiError(
        409,
        'task_unassigned',
        'Assign a task description before recording completion.',
      );
    }
    const summary = (input.summary ?? '').trim();
    if (summary.length === 0 || summary.length > MAX_COMPLETION_SUMMARY_LENGTH) {
      throw new ApiError(
        400,
        'invalid_completion_summary',
        'Describe what the agent completed in 1-4000 characters so completion is not inferred from a process exit.',
      );
    }
    if (task.process_status === 'starting' || task.process_status === 'running') {
      throw new ApiError(
        409,
        'task_cli_running',
        'Stop this agent terminal before recording completion so validation runs against a stable worktree.',
      );
    }

    const workspace = await this.requireOwnedWorkspace(task);
    const head = await requireCommit(workspace.repositoryRoot, `refs/heads/${workspace.branchName}`);
    const commits = await countCommitsBetween(
      workspace.repositoryRoot,
      workspace.baseCommit,
      head,
    );
    if (commits < 1) {
      throw new ApiError(
        409,
        'completion_requires_commit',
        'Completion requires at least one commit on the task branch. Commit the agent work on its branch first.',
      );
    }
    const dirty = await readWorktreeChanges(workspace.worktreePath);
    if (dirty.length > 0) {
      const list = uniqueStrings(dirty.map((file) => `${file.status}: ${file.path}`)).slice(0, 10);
      throw new ApiError(
        409,
        'completion_requires_clean_worktree',
        `Commit or remove the ${dirty.length} uncommitted file(s) in the task worktree before completing: ${list.join(', ')}. Nothing was discarded.`,
      );
    }

    const changes = await readCommittedChanges(
      workspace.repositoryRoot,
      workspace.baseCommit,
      head,
    );
    const changedFiles = uniqueStrings(changes.map((file) => file.path)).slice(0, MAX_ACTUAL_FILES);
    const settings = this.getSettings(task.project_id);
    const scopeViolations = findScopeViolations(
      changedFiles,
      parseJsonArray(task.declared_file_scope_json),
    );

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET completion_summary = ?, completed_at = ?, changed_files_json = ?,
             actual_files_json = ?, scope_violations_json = ?, blocked_reason = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        summary,
        now,
        JSON.stringify(changedFiles),
        JSON.stringify(changedFiles),
        JSON.stringify(scopeViolations),
        now,
        taskId,
      );

    if (settings.validationCommands.length === 0) {
      this.writeTaskState(taskId, 'awaiting_integration', null, {
        validationStatus: 'not_configured',
        validationSummary: 'No validation commands are configured for this project.',
      });
    } else {
      await this.runValidation(taskId);
    }

    const settingsAfter = this.getSettings(task.project_id);
    if (settingsAfter.autoIntegrate) {
      const refreshed = this.requireTaskRow(taskId);
      if (refreshed.state === 'awaiting_integration') {
        try {
          await this.enqueueIntegration(taskId, {});
          await this.processQueue();
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          // The rejection is recorded on the task; completion itself succeeded.
        }
      }
    }

    return this.getTask(taskId);
  }

  async validateTask(taskId: string): Promise<AgentTaskSummary> {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'This task is already integrated.');
    }
    const settings = this.getSettings(task.project_id);
    if (settings.validationCommands.length === 0) {
      throw new ApiError(
        409,
        'validation_not_configured',
        'No validation commands are configured for this project.',
      );
    }
    if (
      this.db
        .prepare(
          `SELECT 1 AS running FROM task_validations WHERE task_id = ? AND status = 'running' LIMIT 1`,
        )
        .get(taskId)
    ) {
      throw new ApiError(409, 'validation_running', 'Validation is already running for this task.');
    }
    if (!task.completion_summary) {
      throw new ApiError(
        409,
        'completion_required',
        'Record completion evidence before running validation.',
      );
    }

    await this.runValidation(taskId);
    return this.getTask(taskId);
  }

  cancelTask(taskId: string): AgentTaskSummary {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'An integrated task cannot be cancelled.');
    }
    if (task.process_status === 'starting' || task.process_status === 'running') {
      throw new ApiError(
        409,
        'task_cli_running',
        'Stop this agent terminal before cancelling the task so no process keeps writing to its worktree.',
      );
    }
    this.executor.cancel(taskId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET state = 'cancelled', blocked_reason = NULL, validation_status = 'failed',
             validation_summary = 'Task cancelled by user.', updated_at = ?
         WHERE id = ?`,
      )
      .run(now, taskId);
    this.db
      .prepare(
        `UPDATE task_integrations SET state = 'rejected', reason = 'Task was cancelled.',
           updated_at = ? WHERE task_id = ? AND state IN ('queued', 'running')`,
      )
      .run(now, taskId);
    this.db
      .prepare('UPDATE agent_tasks SET integration_status = ? WHERE id = ?')
      .run(task.integration_status === 'integrated' ? 'integrated' : 'failed', taskId);
    void this.afterTaskSettled().catch(() => undefined);
    return this.getTask(taskId);
  }

  cancelValidation(taskId: string): boolean {
    return this.executor.cancel(taskId);
  }

  retryTask(taskId: string): AgentTaskSummary {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'This task is already integrated.');
    }
    if (task.state === 'validating') {
      throw new ApiError(
        409,
        'validation_running',
        'Wait for the running validation to finish or cancel it before retrying the task.',
      );
    }
    // Retrying an active task would reset its claim while its CLI is being
    // launched, which would let a second scheduler pass launch it again.
    if (
      task.state === 'assigned' ||
      task.process_status === 'starting' ||
      task.process_status === 'running'
    ) {
      return this.getTask(taskId);
    }
    const now = new Date().toISOString();
    const nextState = task.completion_summary
      ? task.validation_status === 'failed'
        ? 'failed'
        : 'awaiting_integration'
      : 'ready';
    this.db
      .prepare(
        `UPDATE agent_tasks
         SET state = ?, blocked_reason = NULL, integration_reason = NULL,
             integration_status = CASE
               WHEN integration_status = 'integrated' THEN integration_status
               ELSE 'not_requested' END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(nextState, now, taskId);
    return this.getTask(taskId);
  }

  taskLogs(taskId: string): {
    validations: TaskValidationResult[];
    integrations: TaskIntegrationAttempt[];
  } {
    this.requireTaskRow(taskId);
    const validations = this.db
      .prepare('SELECT * FROM task_validations WHERE task_id = ? ORDER BY started_at')
      .all(taskId) as ValidationRow[];
    const integrations = this.db
      .prepare('SELECT * FROM task_integrations WHERE task_id = ? ORDER BY created_at')
      .all(taskId) as IntegrationRow[];
    return {
      validations: validations.map(mapValidationRow),
      integrations: integrations.map(mapIntegrationRow),
    };
  }

  async enqueueIntegration(
    taskId: string,
    options: IntegrationOptions = {},
  ): Promise<AgentTaskSummary> {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'This task is already integrated.');
    }
    if (
      this.db
        .prepare(
          `SELECT 1 AS active FROM task_integrations
           WHERE task_id = ? AND state IN ('queued', 'running') LIMIT 1`,
        )
        .get(taskId)
    ) {
      throw new ApiError(
        409,
        'integration_already_queued',
        'This task already has a queued or running integration.',
      );
    }

    const review = await this.reviewIntegration(task, options);
    const now = new Date().toISOString();
    const attempt = (
      this.db
        .prepare('SELECT COALESCE(MAX(attempt), 0) AS attempt FROM task_integrations WHERE task_id = ?')
        .get(taskId) as { attempt: number }
    ).attempt + 1;

    if (!review.ok) {
      this.db
        .prepare(
          `INSERT INTO task_integrations (
             id, task_id, state, target_branch, source_branch, source_commit,
             target_commit_before, merge_commit, changed_files_json, violations_json,
             reason, attempt, created_at, updated_at
           ) VALUES (?, ?, 'rejected', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          taskId,
          review.targetBranch,
          task.ws_branch_name ?? '',
          review.sourceCommit,
          review.targetCommit,
          JSON.stringify(review.changedFiles),
          JSON.stringify(review.violations),
          review.blockers.join(' '),
          attempt,
          now,
          now,
        );
      this.db
        .prepare(
          `UPDATE agent_tasks SET integration_status = ?, integration_reason = ?,
             scope_violations_json = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          review.code === 'git_conflict' ? 'conflict' : 'failed',
          review.blockers.join(' '),
          JSON.stringify(
            uniqueStrings(
              review.violations
                .filter((value) => value.startsWith('scope:'))
                .map((value) => value.slice('scope:'.length)),
            ),
          ),
          now,
          taskId,
        );
      throw new ApiError(409, review.code, review.blockers.join(' '));
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO task_integrations (
             id, task_id, state, target_branch, source_branch, source_commit,
             target_commit_before, merge_commit, changed_files_json, violations_json,
             reason, attempt, created_at, updated_at
           ) VALUES (?, ?, 'queued', ?, ?, ?, ?, NULL, ?, '[]', NULL, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          taskId,
          review.targetBranch,
          task.ws_branch_name ?? '',
          review.sourceCommit,
          review.targetCommit,
          JSON.stringify(review.changedFiles),
          attempt,
          now,
          now,
        );
      this.db
        .prepare(
          `UPDATE agent_tasks
           SET integration_status = 'queued', integration_reason = NULL,
               target_branch = ?, scope_violations_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          review.targetBranch,
          JSON.stringify(
            uniqueStrings(
              review.violations
                .filter((value) => value.startsWith('scope:'))
                .map((value) => value.slice('scope:'.length)),
            ),
          ),
          now,
          taskId,
        );
    })();

    return this.getTask(taskId);
  }

  processQueue(): Promise<void> {
    return this.serializeQueue(async () => {
      for (;;) {
        const next = this.db
          .prepare(
            `SELECT * FROM task_integrations WHERE state = 'queued'
             ORDER BY created_at, id LIMIT 1`,
          )
          .get() as IntegrationRow | undefined;
        if (!next) return;
        await this.processIntegration(next);
      }
    });
  }

  /**
   * Merges all completed tasks in a session with a single action.
   * Finds tasks ready for integration, queues them, and processes the queue.
   * This is the "Merge all" button — one click to integrate agents A, B, C, D.
   */
  async mergeAll(sessionId: string): Promise<{
    merged: string[];
    skipped: Array<{ taskId: string; reason: string }>;
  }> {
    // Find tasks in this session that are ready to merge
    const tasks = this.db
      .prepare(
        `SELECT at.id AS id, at.state AS state
         FROM agent_tasks at
         JOIN session_terminals st ON st.task_id = at.id
         WHERE st.session_id = ?
           AND at.state IN ('awaiting_integration', 'completed')`,
      )
      .all(sessionId) as Array<{ id: string; state: string }>;

    const merged: string[] = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];

    for (const task of tasks) {
      try {
        // Skip if already queued or integrated
        const existing = this.db
          .prepare(
            `SELECT 1 AS active FROM task_integrations
             WHERE task_id = ? AND state IN ('queued', 'running', 'completed') LIMIT 1`,
          )
          .get(task.id);
        if (existing) {
          skipped.push({ taskId: task.id, reason: 'Already queued or integrated.' });
          continue;
        }
        await this.enqueueIntegration(task.id, {});
        merged.push(task.id);
      } catch (error) {
        skipped.push({
          taskId: task.id,
          reason: error instanceof Error ? error.message : 'Could not queue for integration.',
        });
      }
    }

    // Process the queue to actually merge them
    if (merged.length > 0) {
      await this.processQueue();
    }

    return { merged, skipped };
  }

  /** Recovers interrupted scheduler, validation and integration work after a restart. */
  recover(now = new Date().toISOString()): number {
    let changes = 0;
    this.db.transaction(() => {
      changes += this.db
        .prepare(
          `UPDATE task_validations
           SET status = 'failed', finished_at = ?,
               output = output || '\nInterrupted by a backend restart; the check did not pass.'
           WHERE status = 'running'`,
        )
        .run(now).changes;
      changes += this.db
        .prepare(
          `UPDATE task_integrations
           SET state = 'failed',
               reason = 'Interrupted by a backend restart. The source branch and worktree were preserved.'
           WHERE state = 'running'`,
        )
        .run().changes;
      changes += this.db
        .prepare(
          `UPDATE agent_tasks
           SET state = 'failed', validation_status = 'failed',
               validation_summary = 'Validation was interrupted by a backend restart.',
               updated_at = ?
           WHERE state = 'validating'`,
        )
        .run(now).changes;
      changes += this.db
        .prepare(
          `UPDATE agent_tasks
           SET state = 'ready', blocked_reason = NULL, updated_at = ?
           WHERE state IN ('assigned', 'running')`,
        )
        .run(now).changes;
      changes += this.db
        .prepare(
          `UPDATE agent_tasks SET integration_status = 'failed',
             integration_reason = 'Integration was interrupted by a backend restart.'
           WHERE id IN (
             SELECT task_id FROM task_integrations
             WHERE state = 'failed' AND reason LIKE 'Interrupted by a backend restart%'
           ) AND integration_status = 'queued'`,
        )
        .run().changes;
    })();
    return changes;
  }

  private validateTargetBranchName(projectPath: string, branch: string): void {
    // Branch names are validated synchronously against Git's own rules; the
    // repository check happens when the integration branch is created.
    const forbidden = (value: string): boolean => {
      for (const character of value) {
        if (character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f) return true;
        if ('~^:?*[\\'.includes(character)) return true;
      }
      return false;
    };
    if (
      branch.length === 0 ||
      branch.length > 200 ||
      branch.startsWith('-') ||
      branch.startsWith('/') ||
      branch.endsWith('/') ||
      branch.endsWith('.') ||
      branch.includes('..') ||
      branch.includes('//') ||
      branch.includes('@{') ||
      branch.endsWith('.lock') ||
      forbidden(branch)
    ) {
      throw new ApiError(
        400,
        'invalid_branch_name',
        `"${branch}" is not a valid Git branch name for project ${projectPath}.`,
      );
    }
  }

  private requireProject(projectId: string): { id: string; path: string } {
    const project = this.db
      .prepare('SELECT id, path FROM projects WHERE id = ?')
      .get(projectId) as { id: string; path: string } | undefined;
    if (!project) throw new ApiError(404, 'project_not_found', 'Project not found.');
    return project;
  }

  private requireTaskRow(taskId: string): TaskRow {
    const row = this.db.prepare(`${TASK_SELECT} WHERE at.id = ?`).get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new ApiError(404, 'task_not_found', 'Task not found.');
    return row;
  }

  private withDerivedStates(rows: TaskRow[]): Array<[TaskRow, AgentTaskState, string | null]> {
    const byId = new Map(
      (
        this.db
          .prepare('SELECT id, state, description FROM agent_tasks')
          .all() as Array<{ id: string; state: AgentTaskState; description: string }>
      ).map((row) => [row.id, row]),
    );
    const queuedStates = new Set<AgentTaskState>(['unassigned', 'blocked', 'ready']);

    const toDependency = (id: string): TaskDependencyView => {
      const dependency = byId.get(id);
      return {
        id,
        label: dependency?.description?.trim() || id,
        state: dependency?.state ?? 'unassigned',
      };
    };

    return rows.map((row) => {
      if (!queuedStates.has(row.state)) return [row, row.state, row.blocked_reason];

      const dependencies = parseJsonArray(row.dependencies_json);
      let derived = deriveQueuedState({
        description: row.description,
        currentState: row.state,
        dependencies: dependencies
          .filter((dependency) => byId.has(dependency))
          .map(toDependency),
        missingDependencies: dependencies.filter((dependency) => !byId.has(dependency)),
      });

      // A task that waited for files becomes eligible again only when its
      // writable scopes are actually free, never because a CLI exited.
      let blockedByFiles = false;
      if (derived.state === 'ready' && row.state === 'blocked' && row.wait_kind === 'files') {
        try {
          const scopes = this.declaredScopes(row);
          const conflicts =
            scopes.length > 0
              ? this.leases.conflicts(row.project_id, scopes, { ignoreTaskId: row.id })
              : [];
          if (conflicts.length > 0) {
            derived = {
              state: 'blocked',
              blockedReason: this.describeLeaseConflicts(conflicts),
            };
            blockedByFiles = true;
          }
        } catch {
          // An unresolvable scope keeps the task in its recorded state.
          derived = { state: 'blocked', blockedReason: row.blocked_reason };
          blockedByFiles = true;
        }
      }

      const reason = derived.blockedReason;
      const waitKind =
        derived.state !== 'blocked' ? null : blockedByFiles ? 'files' : 'dependency';
      if (derived.state !== row.state || reason !== row.blocked_reason) {
        this.db
          .prepare(
            `UPDATE agent_tasks
             SET state = ?, blocked_reason = ?, wait_kind = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(derived.state, reason, waitKind, new Date().toISOString(), row.id);
      }
      return [row, derived.state, reason];
    });
  }

  /**
   * Counts agents that are actually consuming a concurrency slot: the task is
   * active and its CLI process is still alive. A task whose CLI already exited
   * keeps its state until the completion report, but no longer blocks capacity.
   */
  private countActiveAgents(): number {
    const states = ACTIVE_TASK_STATES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM agent_tasks at
         JOIN session_terminals st ON st.id = at.terminal_id
         WHERE at.state IN (${states})
           AND st.process_status IN ('starting', 'running')`,
      )
      .get(...ACTIVE_TASK_STATES) as { count: number };
    return Number(row.count);
  }

  private writeTaskState(
    taskId: string,
    state: AgentTaskState,
    blockedReason: string | null,
    extra: {
      validationStatus?: AgentTaskSummary['validationStatus'];
      validationSummary?: string | null;
      integrationStatus?: AgentTaskSummary['integrationStatus'];
      integrationReason?: string | null;
      integrationCommit?: string | null;
      targetBranch?: string | null;
      waitKind?: 'dependency' | 'files' | null;
    } = {},
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_tasks SET
           state = ?, blocked_reason = ?, wait_kind = ?,
           validation_status = COALESCE(?, validation_status),
           validation_summary = COALESCE(?, validation_summary),
           integration_status = COALESCE(?, integration_status),
           integration_reason = COALESCE(?, integration_reason),
           integration_commit = COALESCE(?, integration_commit),
           target_branch = COALESCE(?, target_branch),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state,
        blockedReason,
        extra.waitKind === undefined ? null : extra.waitKind,
        extra.validationStatus ?? null,
        extra.validationSummary === undefined ? null : extra.validationSummary,
        extra.integrationStatus ?? null,
        extra.integrationReason === undefined ? null : extra.integrationReason,
        extra.integrationCommit ?? null,
        extra.targetBranch === undefined ? null : extra.targetBranch,
        now,
        taskId,
      );
    this.db
      .prepare(
        `UPDATE sessions SET updated_at = ?
         WHERE id = (SELECT session_id FROM agent_tasks WHERE id = ?)`,
      )
      .run(now, taskId);
  }

  private serializeTick<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tickChain.catch(() => undefined).then(() =>
      Promise.race<T>([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Scheduler tick timed out after ${this.tickTimeoutMs}ms`)),
            this.tickTimeoutMs,
          ),
        ),
      ]),
    );
    this.tickChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private serializeQueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queueChain.catch(() => undefined).then(() =>
      Promise.race<T>([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Integration queue tick timed out after ${this.tickTimeoutMs}ms`)),
            this.tickTimeoutMs,
          ),
        ),
      ]),
    );
    this.queueChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async claimAndLaunch(filter: { sessionId?: string }): Promise<ScheduleResult> {
    this.syncRunningStates();
    await this.releaseResolvedLeases();
    const now = new Date().toISOString();
    const claims: Array<{ taskId: string; terminalId: string; sessionId: string; projectId: string }> = [];
    const skipped: Array<{ taskId: string; reason: string }> = [];

    const rows = this.withDerivedStates(
      this.db
        .prepare(
          `${TASK_SELECT}${filter.sessionId ? ' WHERE at.session_id = ?' : ''}
           ORDER BY at.created_at, at.id`,
        )
        .all(...(filter.sessionId ? [filter.sessionId] : [])) as TaskRow[],
    ).map(([row, state, reason]) => ({ row, state, reason }));

    const liveTerminalIds = new Set(
      (
        this.db
          .prepare(`SELECT id FROM session_terminals WHERE process_status IN ('starting', 'running')`)
          .all() as Array<{ id: string }>
      ).map((terminal) => terminal.id),
    );
    const sharedTerminalCounts = new Map<string, number>();
    for (const session of this.db
      .prepare('SELECT id, workspace_mode FROM sessions')
      .all() as Array<{ id: string; workspace_mode: WorkspaceMode | null }>) {
      if (session.workspace_mode !== 'shared') continue;
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM session_terminals WHERE session_id = ?')
          .get(session.id) as { count: number }
      ).count;
      sharedTerminalCounts.set(session.id, Number(count));
    }

    let globalActive = this.countActiveAgents();
    const activeByProject = new Map<string, number>();
    for (const entry of this.db
      .prepare(`SELECT s.project_id AS project_id, COUNT(*) AS count
                FROM agent_tasks at
                JOIN sessions s ON s.id = at.session_id
                JOIN session_terminals st ON st.id = at.terminal_id
                WHERE at.state IN ('assigned', 'running', 'validating')
                  AND st.process_status IN ('starting', 'running')
                GROUP BY s.project_id`)
      .all() as Array<{ project_id: string; count: number }>) {
      activeByProject.set(entry.project_id, Number(entry.count));
    }

    for (const { row, state, reason } of rows) {
      if (state !== 'ready') {
        if (row.status !== 'cancelled' && state !== 'unassigned') {
          skipped.push({ taskId: row.id, reason: reason ?? `Task is ${state}.` });
        }
        continue;
      }
      if (liveTerminalIds.has(row.terminal_id)) {
        this.db
          .prepare(
            `UPDATE agent_tasks SET state = 'running', blocked_reason = NULL, wait_kind = NULL,
               updated_at = ? WHERE id = ? AND state = 'ready'`,
          )
          .run(now, row.id);
        skipped.push({ taskId: row.id, reason: 'The agent CLI is already running.' });
        continue;
      }

      const settings = this.getSettings(row.project_id);
      if (settings.schedulingPaused) {
        skipped.push({
          taskId: row.id,
          reason: 'Scheduling is paused for this project. Resume scheduling to launch this task.',
        });
        continue;
      }
      const projectActive = activeByProject.get(row.project_id) ?? 0;
      const projectCap = Math.min(
        settings.maxConcurrentAgents,
        this.systemMaxConcurrentAgents,
      );
      if (globalActive >= this.systemMaxConcurrentAgents) {
        skipped.push({
          taskId: row.id,
          reason: `The backend concurrency limit of ${this.systemMaxConcurrentAgents} agents is in use.`,
        });
        continue;
      }
      if (projectActive >= projectCap) {
        skipped.push({
          taskId: row.id,
          reason: `This project's concurrency limit of ${projectCap} agents is in use.`,
        });
        continue;
      }
      if (this.sessions.liveTerminalCount >= this.maxLiveTerminals) {
        skipped.push({
          taskId: row.id,
          reason: `The backend already runs ${this.maxLiveTerminals} live terminals.`,
        });
        continue;
      }
      if (
        row.workspace_mode === 'shared'
      ) {
        skipped.push({
          taskId: row.id,
          reason:
            'Shared-folder sessions cannot run agent tasks. Convert the session to isolated worktrees first.',
        });
        continue;
      }

      let scopes: ScopeEntry[];
      try {
        scopes = this.declaredScopes(row);
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : 'The writable scope for this task could not be resolved, so it was not launched.';
        this.db
          .prepare(
            `UPDATE agent_tasks
             SET state = 'blocked', blocked_reason = ?, wait_kind = 'files', updated_at = ?
             WHERE id = ? AND state = 'ready'`,
          )
          .run(message, now, row.id);
        skipped.push({ taskId: row.id, reason: message });
        continue;
      }

      let conflicts =
        scopes.length > 0
          ? this.leases.conflicts(row.project_id, scopes, { ignoreTaskId: row.id })
          : [];
      if (conflicts.length > 0) {
        const free = this.leases.freeScopes(row.project_id, scopes, row.id);
        const canReplan =
          row.assigned_at === null &&
          free.length > 0 &&
          free.length < scopes.length &&
          Number(row.replan_count ?? 0) < 3;
        if (canReplan) {
          const owned = uniqueStrings(conflicts.map((conflict) => conflict.path)).join(', ');
          this.applyReplan(
            row,
            free,
            `Automatically replanned into independent writable scope while ${owned} was owned by another task.`,
          );
          scopes = free;
          conflicts = [];
        } else {
          const message = this.describeLeaseConflicts(conflicts);
          this.db
            .prepare(
              `UPDATE agent_tasks
               SET state = 'blocked', blocked_reason = ?, wait_kind = 'files', updated_at = ?
               WHERE id = ? AND state = 'ready'`,
            )
            .run(message, now, row.id);
          skipped.push({ taskId: row.id, reason: message });
          continue;
        }
      }

      // The claim and the writable-scope leases are committed together so a
      // simultaneous scheduler request can never claim the same files.
      const outcome = this.db.transaction((): {
        status: 'claimed' | 'raced' | 'lease_blocked';
        reason?: string;
      } => {
        const claim = this.db
          .prepare(
            `UPDATE agent_tasks
             SET state = 'assigned', assigned_at = ?, blocked_reason = NULL, wait_kind = NULL,
                 updated_at = ?
             WHERE id = ? AND state = 'ready'`,
          )
          .run(now, now, row.id);
        if (claim.changes !== 1) return { status: 'raced' };
        if (scopes.length > 0) {
          const decision = this.leases.acquire({
            taskId: row.id,
            sessionId: row.session_id,
            projectId: row.project_id,
            terminalId: row.terminal_id,
            toolProfileId: row.tool_profile_id,
            scopes,
          });
          if (!decision.ok) {
            const message = this.describeLeaseConflicts(decision.conflicts);
            this.db
              .prepare(
                `UPDATE agent_tasks
                 SET state = 'blocked', blocked_reason = ?, wait_kind = 'files',
                     assigned_at = NULL, updated_at = ?
                 WHERE id = ?`,
              )
              .run(message, now, row.id);
            return { status: 'lease_blocked', reason: message };
          }
        }
        return { status: 'claimed' };
      })();

      if (outcome.status === 'raced') {
        skipped.push({ taskId: row.id, reason: 'The task was claimed by another scheduler request.' });
        continue;
      }
      if (outcome.status === 'lease_blocked') {
        skipped.push({
          taskId: row.id,
          reason: outcome.reason ?? 'Writable files for this task are owned by another task.',
        });
        continue;
      }
      claims.push({
        taskId: row.id,
        terminalId: row.terminal_id,
        sessionId: row.session_id,
        projectId: row.project_id,
      });
      globalActive += 1;
      activeByProject.set(row.project_id, projectActive + 1);
    }

    for (const claim of claims) {
      try {
        // Only the scheduler pass that still holds the claim may launch the
        // CLI. An explicit retry or another pass may have released it, and a
        // second launch of the same terminal would fail halfway.
        const stillClaimed = this.db
          .prepare(`SELECT 1 AS claimed FROM agent_tasks WHERE id = ? AND state = 'assigned'`)
          .get(claim.taskId);
        if (!stillClaimed) {
          skipped.push({
            taskId: claim.taskId,
            reason: 'The task claim changed before the agent CLI could be started.',
          });
          continue;
        }
        // A dependent task must start from the integrated work of its
        // dependencies, so its worktree is advanced before the CLI starts.
        await this.syncDependencyBase(this.requireTaskRow(claim.taskId));
        await this.sessions.startAgentTerminal(claim.terminalId);
        this.writeTaskState(claim.taskId, 'running', null);
      } catch (error) {
        const message =
          error instanceof ApiError
            ? error.message
            : error instanceof Error && error.message
              ? `The agent CLI could not be started: ${error.message}`
              : 'The agent CLI could not be started for this task.';
        this.writeTaskState(claim.taskId, 'failed', message);
        this.leases.setHoldReason(
          claim.taskId,
          'The agent CLI failed to start; the lease is kept until the task worktree is verified clean.',
        );
      }
    }

    return { scheduled: claims.map((claim) => claim.taskId), skipped };
  }

  /** Declared writable scopes resolved against the task's own Git worktree. */
  private declaredScopes(row: TaskRow): ScopeEntry[] {
    const raw = parseJsonArray(row.declared_file_scope_json);
    if (raw.length === 0) return [];
    if (row.ws_repository_root) return resolveScopeEntries(row.ws_repository_root, raw);
    // Shared-folder sessions have no isolated worktree to resolve against.
    return raw.map((entry) => ({
      path: normalizeLeasePath(entry),
      isDirectory: entry.trim().endsWith('/'),
    }));
  }

  private describeLeaseConflicts(conflicts: LeaseConflict[]): string {
    const sample = conflicts
      .slice(0, 6)
      .map(
        (conflict) =>
          `"${conflict.path}" is owned by "${conflict.ownerTaskLabel}" (${conflict.ownerState.replace(/_/g, ' ')})`,
      );
    return `Waiting for file ownership: ${sample.join('; ')}${
      conflicts.length > sample.length ? ' (more…)' : ''
    }. The task was not launched and will resume when those files are released.`;
  }

  /**
   * Narrows a task's declared scope to genuinely independent writable paths and
   * records the deferred paths, without touching any file on disk.
   */
  private applyReplan(row: TaskRow, scopes: ScopeEntry[], reason: string): void {
    const previous = parseJsonArray(row.declared_file_scope_json);
    const next = scopes.map((scope) => scope.path);
    const deferred = previous.filter((entry) => !next.includes(entry));
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_tasks
           SET declared_file_scope_json = ?, deferred_scope_json = ?,
               replan_count = replan_count + 1, blocked_reason = NULL, wait_kind = NULL,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(next), JSON.stringify(deferred), now, row.id);
      this.db
        .prepare(
          `INSERT INTO task_replans (
             id, task_id, previous_scope_json, new_scope_json, deferred_scope_json,
             reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          row.id,
          JSON.stringify(previous),
          JSON.stringify(next),
          JSON.stringify(deferred),
          reason,
          now,
        );
    })();
    row.declared_file_scope_json = JSON.stringify(next);
    row.deferred_scope_json = JSON.stringify(deferred);
    row.replan_count = Number(row.replan_count ?? 0) + 1;
  }

  /**
   * Narrows a task to scopes that no other task owns. The generated plan is
   * persisted with the deferred paths and shown in the waiting/schedule UI.
   */
  replanTask(taskId: string, input: { scopes?: string[] } = {}): AgentTaskSummary {
    const task = this.requireTaskRow(taskId);
    if (task.state === 'integrated') {
      throw new ApiError(409, 'task_already_integrated', 'An integrated task cannot be replanned.');
    }
    if (task.process_status === 'starting' || task.process_status === 'running') {
      throw new ApiError(
        409,
        'task_cli_running',
        'Stop this agent terminal before replanning so its writable scope cannot change under a running process.',
      );
    }
    if (task.completion_summary) {
      throw new ApiError(
        409,
        'completion_recorded',
        'Replanning is only possible before completion evidence is recorded. Revert or cancel the task first.',
      );
    }

    const requested =
      input.scopes && input.scopes.length > 0
        ? task.ws_repository_root
          ? resolveScopeEntries(task.ws_repository_root, input.scopes)
          : input.scopes.map((entry) => ({
              path: normalizeLeasePath(entry),
              isDirectory: entry.trim().endsWith('/'),
            }))
        : this.declaredScopes(task);
    if (requested.length === 0) {
      throw new ApiError(
        409,
        'no_independent_scope',
        'This task has no writable scope to replan. Declare a repository-relative file or directory first.',
      );
    }

    const conflicts = this.leases.conflicts(task.project_id, requested, {
      ignoreTaskId: task.id,
    });
    if (conflicts.length === 0) {
      return this.getTask(task.id);
    }
    const free = this.leases.freeScopes(task.project_id, requested, task.id);
    if (free.length === 0) {
      throw new ApiError(409, 'no_independent_scope', this.describeLeaseConflicts(conflicts));
    }
    this.applyReplan(
      task,
      free,
      `Replanned to independent writable scope; deferred ${conflicts
        .map((conflict) => conflict.path)
        .join(', ')}.`,
    );
    return this.getTask(task.id);
  }

  /**
   * Releases writable-scope leases only once a task's work is safely resolved.
   * A task whose CLI is alive, or whose worktree still holds commits or
   * uncommitted files, keeps its lease and a visible hold reason.
   */
  private async releaseResolvedLeases(): Promise<number> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT at.id, at.state, at.terminal_id,
                st.process_status,
                aw.repository_root, aw.branch_name, aw.base_commit, aw.worktree_path
         FROM agent_task_leases l
         JOIN agent_tasks at ON at.id = l.task_id
         JOIN session_terminals st ON st.id = at.terminal_id
         LEFT JOIN agent_workspaces aw ON aw.terminal_id = at.terminal_id
         WHERE l.state = 'active'`,
      )
      .all() as Array<{
      id: string;
      state: AgentTaskState;
      terminal_id: string;
      process_status: string;
      repository_root: string | null;
      branch_name: string | null;
      base_commit: string | null;
      worktree_path: string | null;
    }>;

    let released = 0;
    for (const row of rows) {
      if (
        this.sessions.hasLiveTerminal(row.terminal_id) ||
        row.process_status === 'starting' ||
        row.process_status === 'running'
      ) {
        this.leases.setHoldReason(row.id, 'The agent CLI is still running.');
        continue;
      }
      if (row.state === 'integrated' || row.state === 'interrupted') {
        released += this.leases.releaseTask(
          row.id,
          row.state === 'integrated'
            ? 'The task changes were integrated successfully.'
            : 'The agent CLI process died; the task is interrupted and its leases are released.',
        );
        continue;
      }
      if (row.state === 'cancelled' || row.state === 'failed') {
        const outstanding = await this.describeOutstandingWork(row);
        if (outstanding === null) {
          released += this.leases.releaseTask(
            row.id,
            `The ${row.state} task has no outstanding commits or uncommitted changes.`,
          );
        } else {
          this.leases.setHoldReason(row.id, outstanding);
        }
        continue;
      }
      this.leases.setHoldReason(
        row.id,
        `The task is ${row.state.replace(/_/g, ' ')} and still owns its writable files.`,
      );
    }
    return released;
  }

  /** Returns null when the task has nothing outstanding, else a hold reason. */
  private async describeOutstandingWork(row: {
    repository_root: string | null;
    branch_name: string | null;
    base_commit: string | null;
    worktree_path: string | null;
  }): Promise<string | null> {
    if (!row.repository_root || !row.branch_name || !row.base_commit || !row.worktree_path) {
      return 'The task has no recorded worktree, so its writable files stay owned until the task is removed.';
    }
    try {
      const head = await requireCommit(row.repository_root, `refs/heads/${row.branch_name}`);
      if (head !== row.base_commit) {
        return 'The task still has commits that are not integrated.';
      }
      const dirty = await readWorktreeChanges(row.worktree_path);
      if (dirty.length > 0) {
        return 'The task worktree still has uncommitted changes.';
      }
      return null;
    } catch {
      return 'The task worktree could not be inspected, so its writable files stay owned.';
    }
  }

  /** Releasing a lease is always followed by a fresh scheduling pass. */
  private async afterTaskSettled(): Promise<void> {
    await this.releaseResolvedLeases();
    await this.scheduleAll();
  }

  /**
   * Advances a dependent task's worktree to the current integration target so
   * its CLI starts from the committed work of its dependencies. The update is a
   * fast-forward executed inside the task worktree and only happens when the
   * branch is exactly at its recorded base, the worktree is clean, and no CLI
   * owns it. Anything unexpected is reported as a recoverable error and nothing
   * is rewritten.
   */
  private async syncDependencyBase(task: TaskRow): Promise<void> {
    const dependencies = parseJsonArray(task.dependencies_json);
    if (dependencies.length === 0) return;
    if (this.sessions.hasLiveTerminal(task.terminal_id)) {
      throw new ApiError(
        409,
        'git_workspace_busy',
        'The agent CLI is already running in this task worktree, so its base was not changed.',
      );
    }

    const workspace = await this.requireOwnedWorkspace(task);
    const settings = this.getSettings(task.project_id);
    const targetBranch = settings.resolvedTargetBranch;
    const targetCommit = await resolveCommitOrNull(
      workspace.repositoryRoot,
      `refs/heads/${targetBranch}`,
    );
    if (!targetCommit) {
      throw new ApiError(
        409,
        'integration_target_missing',
        `The integration branch "${targetBranch}" does not exist, so the integrated dependency work cannot be used as this task's base. Integrate the dependency first, or restore the target branch.`,
      );
    }

    const branchHead = await requireCommit(
      workspace.repositoryRoot,
      `refs/heads/${workspace.branchName}`,
    );
    if (branchHead === targetCommit) {
      if (workspace.baseCommit !== targetCommit) {
        this.recordWorkspaceBase(task.terminal_id, workspace.baseCommit, targetCommit);
      }
      return;
    }
    if (branchHead !== workspace.baseCommit) {
      throw new ApiError(
        409,
        'git_workspace_unexpected_commits',
        `The worktree for this task has commits beyond its recorded base (${branchHead.slice(0, 12)} instead of ${workspace.baseCommit.slice(0, 12)}). It was left untouched; review the branch before retrying.`,
      );
    }

    const dirty = await readWorktreeChanges(workspace.worktreePath);
    if (dirty.length > 0) {
      const list = uniqueStrings(dirty.map((file) => `${file.status}: ${file.path}`)).slice(0, 10);
      throw new ApiError(
        409,
        'git_workspace_dirty',
        `The worktree for this task has ${dirty.length} uncommitted or untracked file(s), so its base was not updated and nothing was discarded: ${list.join(', ')}. Commit or remove them and retry.`,
      );
    }

    if (targetCommit === workspace.baseCommit) return;
    if (!(await isAncestor(workspace.repositoryRoot, workspace.baseCommit, targetCommit))) {
      throw new ApiError(
        409,
        'integration_target_diverged',
        `The integration branch "${targetBranch}" no longer contains this task's base commit, so its worktree was left unchanged. Recreate the task workspace or integrate from a shared base.`,
      );
    }

    const update = await fastForwardWorktree(workspace.worktreePath, targetCommit);
    if (!update.ok) {
      throw new ApiError(
        409,
        'git_workspace_update_failed',
        `The task worktree could not be fast-forwarded to the integration branch${update.detail ? `: ${update.detail}` : '.'} Nothing was discarded.`,
      );
    }
    const updatedHead = await headCommit(workspace.worktreePath);
    if (updatedHead !== targetCommit) {
      throw new ApiError(
        409,
        'git_workspace_update_failed',
        'The task worktree did not end up on the integration commit after the update. Nothing was discarded.',
      );
    }
    this.recordWorkspaceBase(task.terminal_id, workspace.baseCommit, targetCommit);
  }

  /**
   * Records the new base commit with a compare-and-swap so a concurrent
   * scheduler cannot silently move the same worktree twice.
   */
  private recordWorkspaceBase(
    terminalId: string,
    expectedBase: string,
    nextBase: string,
  ): void {
    const changed = this.db
      .prepare(
        `UPDATE agent_workspaces SET base_commit = ?, updated_at = ?
         WHERE terminal_id = ? AND base_commit IN (?, ?)`,
      )
      .run(nextBase, new Date().toISOString(), terminalId, expectedBase, nextBase).changes;
    if (changed !== 1) {
      throw new ApiError(
        409,
        'git_workspace_base_conflict',
        'The recorded worktree base changed while it was being prepared. Retry the schedule request.',
      );
    }
  }

  private async requireOwnedWorkspace(task: TaskRow): Promise<TaskWorkspace> {
    if (
      task.ws_status !== 'ready' ||
      !task.ws_worktree_path ||
      !task.ws_working_directory ||
      !task.ws_branch_name ||
      !task.ws_repository_root ||
      !task.ws_base_commit
    ) {
      throw new ApiError(
        409,
        'git_workspace_unavailable',
        task.ws_error ??
          'This task does not own a ready isolated worktree. Convert the session to isolated worktrees first.',
      );
    }
    await validateGitWorkspace(task.ws_worktree_path, task.ws_working_directory);
    const branch = await currentBranch(task.ws_worktree_path);
    if (branch !== task.ws_branch_name) {
      throw new ApiError(
        409,
        'git_workspace_ownership_mismatch',
        `The task worktree is on "${branch ?? 'a detached HEAD'}" instead of its owned branch "${task.ws_branch_name}".`,
      );
    }
    if ((await resolveCommitOrNull(task.ws_repository_root, `refs/heads/${task.ws_branch_name}`)) === null) {
      throw new ApiError(
        409,
        'git_ref_missing',
        `The task branch "${task.ws_branch_name}" no longer exists.`,
      );
    }
    return {
      repositoryRoot: task.ws_repository_root,
      worktreePath: task.ws_worktree_path,
      workingDirectory: task.ws_working_directory,
      branchName: task.ws_branch_name,
      baseCommit: task.ws_base_commit,
    };
  }

  private async runValidation(taskId: string): Promise<void> {
    const task = this.requireTaskRow(taskId);
    const workspace = await this.requireOwnedWorkspace(task);
    const settings = this.getSettings(task.project_id);
    if (settings.validationCommands.length === 0) {
      throw new ApiError(
        409,
        'validation_not_configured',
        'No validation commands are configured for this project.',
      );
    }

    const attempt = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(attempt), 0) AS attempt FROM task_validations WHERE task_id = ?',
        )
        .get(taskId) as { attempt: number }
    ).attempt + 1;

    this.writeTaskState(taskId, 'validating', null, { validationStatus: 'pending' });

    const results: Array<{ command: ValidationCommandConfig; result: Awaited<ReturnType<ValidationExecutor['execute']>> }> = [];
    await this.executor.runExclusive(workspace.worktreePath, async () => {
      for (const command of settings.validationCommands) {
        const startedAt = new Date().toISOString();
        const id = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO task_validations (
               id, task_id, attempt, name, command, args_json, status, exit_code,
               duration_ms, output, started_at, finished_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, NULL, '', ?, NULL)`,
          )
          .run(
            id,
            taskId,
            attempt,
            command.name,
            command.command,
            JSON.stringify(command.args),
            startedAt,
          );

        const result = await this.executor.execute(taskId, command, workspace.worktreePath);
        const finishedAt = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE task_validations
             SET status = ?, exit_code = ?, duration_ms = ?, output = ?, finished_at = ?
             WHERE id = ?`,
          )
          .run(result.status, result.exitCode, result.durationMs, result.output, finishedAt, id);
        results.push({ command, result });
        if (result.status !== 'passed' && command.required) break;
        if (result.status === 'cancelled') break;
      }
    });

    const required = results.filter((entry) => entry.command.required);
    const failed = required.find((entry) => entry.result.status !== 'passed');
    const remaining = settings.validationCommands.length - results.length;
    const cancelled = results.some((entry) => entry.result.status === 'cancelled');

    if (failed || remaining > 0) {
      const reason = cancelled
        ? 'Validation was cancelled; a cancelled check is never treated as a pass.'
        : failed
          ? `Validation check "${failed.command.name}" ${
              failed.result.status === 'timed_out'
                ? 'timed out'
                : failed.result.status === 'cancelled'
                  ? 'was cancelled'
                  : `failed with exit code ${failed.result.exitCode ?? 'unknown'}`
            }.`
          : 'Validation stopped before every required check ran.';
      this.writeTaskState(taskId, 'failed', reason, {
        validationStatus: 'failed',
        validationSummary: reason,
      });
      return;
    }

    const summary =
      results.length === 0
        ? 'No validation commands ran.'
        : `${results.filter((entry) => entry.result.status === 'passed').length}/${results.length} checks passed.`;
    this.writeTaskState(taskId, 'awaiting_integration', null, {
      validationStatus: 'passed',
      validationSummary: summary,
    });
  }

  private validationWorktreePath(
    repositoryRoot: string,
    taskId: string,
    attempt: number,
  ): string {
    // Short deterministic paths keep Git for Windows away from PATH_MAX.
    const repositoryKey = crypto
      .createHash('sha256')
      .update(path.resolve(repositoryRoot).toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const taskKey = crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 12);
    return path.join(
      this.runtimeDir!,
      VALIDATION_WORKTREES_DIRECTORY,
      repositoryKey,
      `${taskKey}-${attempt}`,
    );
  }

  /**
   * Validates the exact combined merge candidate in a detached temporary
   * worktree. The integration ref and the project's working directory are never
   * touched, and the temporary worktree is only removed once the validation
   * process has exited.
   */
  private async validateIntegrationCandidate(input: {
    task: TaskRow;
    settings: OrchestrationSettings;
    repositoryRoot: string;
    projectPath: string;
    candidateCommit: string;
    attempt: number;
  }): Promise<CandidateValidationResult> {
    const { task, settings, repositoryRoot, projectPath, candidateCommit, attempt } = input;
    if (settings.validationCommands.length === 0) {
      return {
        ok: true,
        summary: 'No validation commands are configured; the combined candidate was not validated.',
        reason: null,
      };
    }

    if (!this.runtimeDir) {
      return {
        ok: false,
        summary: '',
        reason:
          'The backend runtime directory is not configured, so the combined candidate cannot be validated in isolation.',
      };
    }

    const relativeProject = path.relative(
      path.resolve(repositoryRoot),
      path.resolve(projectPath),
    );
    if (relativeProject.startsWith('..') || path.isAbsolute(relativeProject)) {
      return {
        ok: false,
        summary: '',
        reason: 'The project folder is outside the Git repository, so the combined candidate could not be validated.',
      };
    }

    const worktreePath = this.validationWorktreePath(repositoryRoot, task.id, attempt);
    const workingDirectory = path.resolve(worktreePath, relativeProject);
    let prepared = false;

    try {
      if (fs.existsSync(worktreePath)) {
        // Only a worktree Git still owns is removed; unknown directories are
        // reported instead of being deleted.
        await removeGitWorktree(repositoryRoot, worktreePath);
        if (fs.existsSync(worktreePath)) {
          throw new ApiError(
            409,
            'validation_workspace_stale',
            'A leftover validation directory was found and left untouched instead of being deleted.',
          );
        }
      }
      await addDetachedWorktree(repositoryRoot, worktreePath, candidateCommit);
      prepared = true;

      const results: Array<{
        command: ValidationCommandConfig;
        result: Awaited<ReturnType<ValidationExecutor['execute']>>;
      }> = [];
      await this.executor.runExclusive(task.id, async () => {
        for (const command of settings.validationCommands) {
          const startedAt = new Date().toISOString();
          const id = crypto.randomUUID();
          this.db
            .prepare(
              `INSERT INTO task_validations (
                 id, task_id, attempt, phase, name, command, args_json, status,
                 exit_code, duration_ms, output, started_at, finished_at
               ) VALUES (?, ?, ?, 'integration', ?, ?, ?, 'running', NULL, NULL, '', ?, NULL)`,
            )
            .run(
              id,
              task.id,
              attempt,
              command.name,
              command.command,
              JSON.stringify(command.args),
              startedAt,
            );

          const result = await this.executor.execute(task.id, command, workingDirectory);
          this.db
            .prepare(
              `UPDATE task_validations
               SET status = ?, exit_code = ?, duration_ms = ?, output = ?, finished_at = ?
               WHERE id = ?`,
            )
            .run(
              result.status,
              result.exitCode,
              result.durationMs,
              result.output,
              new Date().toISOString(),
              id,
            );
          results.push({ command, result });
          if (result.status !== 'passed' && command.required) break;
          if (result.status === 'cancelled') break;
        }
      });

      const required = results.filter((entry) => entry.command.required);
      const failed = required.find((entry) => entry.result.status !== 'passed');
      const remaining = settings.validationCommands.length - results.length;
      const cancelled = results.some((entry) => entry.result.status === 'cancelled');
      const summary = `${results.filter((entry) => entry.result.status === 'passed').length}/${results.length} check(s) passed on the combined candidate.`;

      if (failed || remaining > 0) {
        const reason = cancelled
          ? 'Validation of the combined candidate was cancelled, so the integration target was not updated.'
          : failed
            ? `Combined-candidate check "${failed.command.name}" ${
                failed.result.status === 'timed_out'
                  ? 'timed out'
                  : failed.result.status === 'cancelled'
                    ? 'was cancelled'
                    : `failed with exit code ${failed.result.exitCode ?? 'unknown'}`
              }, so the integration target was not updated.`
            : 'Validation of the combined candidate stopped before every required check ran, so the integration target was not updated.';
        return { ok: false, summary, reason };
      }
      return { ok: true, summary, reason: null };
    } catch (error) {
      return {
        ok: false,
        summary: '',
        reason:
          error instanceof ApiError
            ? error.message
            : 'The combined integration candidate could not be validated.',
      };
    } finally {
      if (prepared) {
        try {
          if (!this.executor.isRunning(task.id)) {
            await removeGitWorktree(repositoryRoot, worktreePath);
          }
        } catch {
          // The leftover worktree is kept for inspection and reused safely later.
        }
      }
    }
  }

  private async reviewIntegration(
    task: TaskRow,
    options: IntegrationOptions,
  ): Promise<IntegrationReview> {
    const settings = this.getSettings(task.project_id);
    const blockers: string[] = [];
    const violations: string[] = [];
    const targetBranch = settings.resolvedTargetBranch;
    const review: IntegrationReview = {
      ok: false,
      code: 'integration_blocked',
      blockers,
      changedFiles: [],
      violations,
      sourceCommit: null,
      targetCommit: null,
      targetBranch,
    };

    if (!task.completion_summary || !task.completed_at) {
      blockers.push('No completion evidence is recorded for this task.');
      review.code = 'completion_required';
      return review;
    }

    let workspace: TaskWorkspace;
    try {
      workspace = await this.requireOwnedWorkspace(task);
    } catch (error) {
      blockers.push(error instanceof ApiError ? error.message : 'The task worktree is unavailable.');
      return review;
    }

    if (task.integration_status === 'integrated' || task.integration_commit) {
      blockers.push('This task is already integrated.');
      review.code = 'task_already_integrated';
      return review;
    }

    if (task.validation_status !== 'passed') {
      const configured = settings.validationCommands.length > 0;
      if (configured) {
        blockers.push('Required validation checks have not passed.');
        review.code = 'validation_failed';
      } else if (!options.acknowledgeNoValidation) {
        blockers.push(
          'No validation commands are configured. Add checks, or explicitly acknowledge integrating without validation.',
        );
        review.code = 'validation_not_configured';
      }
    }

    const dependencyIds = parseJsonArray(task.dependencies_json);
    if (dependencyIds.length > 0) {
      const dependencies = this.db
        .prepare(
          `SELECT id, state, description FROM agent_tasks WHERE id IN (${dependencyIds.map(() => '?').join(', ')})`,
        )
        .all(...dependencyIds) as Array<{ id: string; state: AgentTaskState; description: string }>;
      const unresolved = dependencyIds.filter((dependencyId) => {
        const dependency = dependencies.find((entry) => entry.id === dependencyId);
        return !dependency || dependency.state !== 'integrated';
      });
      if (unresolved.length > 0) {
        blockers.push(
          `Dependencies must be integrated first: ${unresolved
            .map((dependencyId) => {
              const dependency = dependencies.find((entry) => entry.id === dependencyId);
              return `${dependency?.description?.trim() || dependencyId} (${dependency?.state ?? 'missing'})`;
            })
            .join(', ')}.`,
        );
        review.code = 'dependencies_not_integrated';
      }
    }

    const dirty = await readWorktreeChanges(workspace.worktreePath);
    if (dirty.length > 0) {
      blockers.push(
        `The task worktree has ${dirty.length} uncommitted or untracked file(s); commit or remove them before integration.`,
      );
      review.code = 'uncommitted_changes';
    }

    const sourceCommit = await requireCommit(
      workspace.repositoryRoot,
      `refs/heads/${workspace.branchName}`,
    );
    const commitsAhead = await countCommitsBetween(
      workspace.repositoryRoot,
      workspace.baseCommit,
      sourceCommit,
    );
    if (commitsAhead < 1) {
      blockers.push('The task branch has no commits beyond its base commit.');
      review.code = 'completion_requires_commit';
    }
    review.sourceCommit = sourceCommit;

    const changes = await readCommittedChanges(
      workspace.repositoryRoot,
      workspace.baseCommit,
      sourceCommit,
    );
    const changedFiles = uniqueStrings(
      changes.flatMap((file) => (file.previousPath ? [file.path, file.previousPath] : [file.path])),
    ).slice(0, MAX_ACTUAL_FILES);
    review.changedFiles = changedFiles;

    const declaredScope = parseJsonArray(task.declared_file_scope_json);
    const scopeViolations = findScopeViolations(changedFiles, declaredScope);
    if (scopeViolations.length > 0) {
      violations.push(...scopeViolations.map((file) => `scope:${file}`));
      if (!options.allowOutOfScope) {
        blockers.push(
          `Changes outside the declared scope were found: ${scopeViolations.slice(0, 10).join(', ')}${scopeViolations.length > 10 ? ' (more…)' : ''}. Review and explicitly approve them, or revert them.`,
        );
        review.code = 'scope_violation';
      }
    }

    const protectedViolations = findProtectedViolations(
      changedFiles,
      settings.protectedPaths,
    );
    if (protectedViolations.length > 0) {
      violations.push(...protectedViolations.map((file) => `protected:${file}`));
      blockers.push(
        `Protected paths were modified: ${protectedViolations.join(', ')}. These changes cannot be integrated automatically.`,
      );
      review.code = 'protected_path_violation';
    }

    const overlapping = this.findOverlappingChanges(task, changedFiles);
    if (overlapping.length > 0) {
      violations.push(...overlapping.map((file) => `overlap:${file}`));
      blockers.push(
        `These files were also changed by an already integrated task: ${overlapping.slice(0, 10).join(', ')}.`,
      );
      review.code = 'overlapping_changes';
    }

    if (targetBranch === workspace.branchName) {
      blockers.push('The integration target cannot be the task branch itself.');
      review.code = 'invalid_target_branch';
      return review;
    }

    let targetCommit = await resolveCommitOrNull(
      workspace.repositoryRoot,
      `refs/heads/${targetBranch}`,
    );
    if (!targetCommit) {
      // The integration branch is created from the project's current commit,
      // never from uncommitted work.
      const base = await resolveCommitOrNull(workspace.repositoryRoot, 'HEAD');
      if (!base) {
        blockers.push('The repository has no commit to create the integration branch from.');
        review.code = 'git_repository_unborn';
        return review;
      }
      await validateBranchName(workspace.repositoryRoot, targetBranch);
      targetCommit = await createBranchIfMissing(
        workspace.repositoryRoot,
        targetBranch,
        base,
      );
    }
    review.targetCommit = targetCommit;

    if (await isBranchCheckedOut(workspace.repositoryRoot, targetBranch)) {
      blockers.push(
        `The integration target "${targetBranch}" is checked out in a worktree. Integration only updates the branch ref, so check out another branch or choose a dedicated integration branch.`,
      );
      review.code = 'target_branch_checked_out';
    }

    if (commitsAhead >= 1) {
      const merge = await checkMerge(
        workspace.repositoryRoot,
        `refs/heads/${targetBranch}`,
        sourceCommit,
      );
      if (!merge.clean) {
        blockers.push(
          `Git conflicts with "${targetBranch}"${merge.conflicts.length ? `: ${merge.conflicts.join(', ')}` : ''}. Resolve them on the task branch; DevPilot never force-resolves conflicts.`,
        );
        review.code = 'git_conflict';
      }
    }

    review.ok = blockers.length === 0;
    if (review.ok) review.code = 'ok';
    return review;
  }

  private findOverlappingChanges(task: TaskRow, changedFiles: string[]): string[] {
    const integrated = this.db
      .prepare(
        `SELECT at.actual_files_json
         FROM agent_tasks at
         JOIN sessions s ON s.id = at.session_id
         WHERE s.project_id = ? AND at.id != ? AND at.state = 'integrated'`,
      )
      .all(task.project_id, task.id) as Array<{ actual_files_json: string }>;
    const integratedFiles = new Set<string>();
    for (const row of integrated) {
      for (const file of parseJsonArray(row.actual_files_json)) {
        integratedFiles.add(normalizeRepoPath(file).toLowerCase());
      }
    }
    return changedFiles.filter((file) => integratedFiles.has(normalizeRepoPath(file).toLowerCase()));
  }

  private async processIntegration(row: IntegrationRow): Promise<void> {
    const claimed = this.db
      .prepare(
        `UPDATE task_integrations SET state = 'running', updated_at = ?
         WHERE id = ? AND state = 'queued'`,
      )
      .run(new Date().toISOString(), row.id);
    if (claimed.changes !== 1) return;

    const fail = (
      state: 'rejected' | 'failed',
      code: string,
      reason: string,
      extra: { candidateCommit?: string | null; validationSummary?: string | null } = {},
    ): void => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE task_integrations
           SET state = ?, reason = ?, candidate_commit = COALESCE(?, candidate_commit),
               validation_summary = COALESCE(?, validation_summary), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          state,
          reason,
          extra.candidateCommit ?? null,
          extra.validationSummary ?? null,
          now,
          row.id,
        );
      const taskState =
        code === 'validation_failed' || code === 'completion_required'
          ? 'failed'
          : 'awaiting_integration';
      this.db
        .prepare(
          `UPDATE agent_tasks SET integration_status = ?, integration_reason = ?,
             state = CASE WHEN state = 'integrated' THEN state ELSE ? END,
             updated_at = ? WHERE id = ?`,
        )
        .run(code === 'git_conflict' ? 'conflict' : 'failed', reason, taskState, now, row.task_id);
    };

    try {
      const task = this.requireTaskRow(row.task_id);
      const settings = this.getSettings(task.project_id);
      const review = await this.reviewIntegration(task, {
        // The queued row itself is the explicit request, so an unconfigured
        // validation pipeline does not block it. Failed configured checks do.
        acknowledgeNoValidation: true,
        allowOutOfScope: true,
      });
      if (!review.ok) {
        fail(review.code === 'git_conflict' ? 'rejected' : 'failed', review.code, review.blockers.join(' '));
        return;
      }

      const workspace = await this.requireOwnedWorkspace(task);
      const sourceCommit = review.sourceCommit;
      if (!sourceCommit) {
        fail('failed', 'git_ref_missing', 'The source branch has no commit to integrate.');
        return;
      }
      if (sourceCommit !== row.source_commit) {
        fail(
          'rejected',
          'stale_candidate',
          'The task branch changed after it was queued. Revalidate the new commit before integrating it.',
        );
        return;
      }
      const queuedFiles = uniqueStrings(parseJsonArray(row.changed_files_json)).sort();
      const currentFiles = uniqueStrings(review.changedFiles).sort();
      if (
        queuedFiles.length !== currentFiles.length ||
        queuedFiles.some((file, index) => file !== currentFiles[index])
      ) {
        fail(
          'rejected',
          'stale_candidate',
          'The task change set changed after it was queued. Revalidate and queue the integration again.',
        );
        return;
      }

      const targetBranch = settings.resolvedTargetBranch;
      const targetTip = await requireCommit(
        workspace.repositoryRoot,
        `refs/heads/${targetBranch}`,
      );
      // Recheck the target and conflicts immediately before mutating any ref.
      if (targetTip !== row.target_commit_before) {
        const recheck = await checkMerge(
          workspace.repositoryRoot,
          targetTip,
          sourceCommit,
        );
        if (!recheck.clean) {
          fail(
            'rejected',
            'git_conflict',
            `The target branch changed and now conflicts with this task${
              recheck.conflicts.length ? `: ${recheck.conflicts.join(', ')}` : ''
            }. Revalidate and integrate again.`,
          );
          return;
        }
      }
      const merge = await checkMerge(
        workspace.repositoryRoot,
        targetTip,
        sourceCommit,
      );
      if (!merge.clean || !merge.tree) {
        fail(
          'rejected',
          'git_conflict',
          `Git conflicts with "${targetBranch}"${merge.conflicts.length ? `: ${merge.conflicts.join(', ')}` : ''}. The source branch was kept.`,
        );
        return;
      }

      const mergeCommit = await createMergeCommit(
        workspace.repositoryRoot,
        merge.tree,
        [targetTip, sourceCommit],
        `DevPilot: integrate ${task.description.trim().slice(0, 120) || task.id} (${workspace.branchName})`,
      );
      // The exact combined candidate is validated in its own detached worktree
      // before the integration ref is allowed to move.
      const project = this.requireProject(task.project_id);
      const candidateValidation = await this.validateIntegrationCandidate({
        task,
        settings,
        repositoryRoot: workspace.repositoryRoot,
        projectPath: project.path,
        candidateCommit: mergeCommit,
        attempt: Number(row.attempt),
      });
      if (!candidateValidation.ok) {
        fail('rejected', 'integration_validation_failed', candidateValidation.reason ??
          'The combined integration candidate did not pass validation, so the integration target was not updated.', {
          candidateCommit: mergeCommit,
          validationSummary: candidateValidation.summary,
        });
        return;
      }

      const targetAfterValidation = await resolveCommitOrNull(
        workspace.repositoryRoot,
        `refs/heads/${targetBranch}`,
      );
      if (targetAfterValidation !== targetTip) {
        fail(
          'rejected',
          'target_changed',
          `"${targetBranch}" moved while the combined candidate was being validated; no ref was changed. Retry the integration.`,
          { candidateCommit: mergeCommit, validationSummary: candidateValidation.summary },
        );
        return;
      }
      if (await isBranchCheckedOut(workspace.repositoryRoot, targetBranch)) {
        fail(
          'rejected',
          'target_branch_checked_out',
          `"${targetBranch}" became checked out before the integration could be applied; no ref was changed.`,
        );
        return;
      }
      const updated = await updateBranchRef(
        workspace.repositoryRoot,
        targetBranch,
        mergeCommit,
        targetTip,
      );
      if (!updated) {
        fail(
          'rejected',
          'target_changed',
          `"${targetBranch}" moved while this task was integrating; no ref was changed. Retry the integration.`,
          { candidateCommit: mergeCommit, validationSummary: candidateValidation.summary },
        );
        return;
      }
      const applied = await requireCommit(
        workspace.repositoryRoot,
        `refs/heads/${targetBranch}`,
      );
      if (!(await isAncestor(workspace.repositoryRoot, mergeCommit, applied))) {
        fail(
          'failed',
          'git_integration_failed',
          'Git reported success but the merge commit is not on the target branch.',
        );
        return;
      }

      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE task_integrations
             SET state = 'integrated', merge_commit = ?, target_commit_before = ?,
                 candidate_commit = ?, validation_summary = ?,
                 changed_files_json = ?, reason = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            mergeCommit,
            targetTip,
            mergeCommit,
            candidateValidation.summary,
            JSON.stringify(review.changedFiles),
            now,
            row.id,
          );
        this.db
          .prepare(
            `UPDATE agent_tasks
             SET state = 'integrated', integration_status = 'integrated',
                 integration_commit = ?, target_branch = ?, integration_reason = NULL,
                 actual_files_json = ?, changed_files_json = ?, blocked_reason = NULL,
                 updated_at = ?
             WHERE id = ?`,
          )
          .run(
            mergeCommit,
            targetBranch,
            JSON.stringify(review.changedFiles),
            JSON.stringify(review.changedFiles),
            now,
            row.task_id,
          );
        this.db
          .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
          .run(now, task.session_id);
      })();

      // Clean up the task's worktree and branch after successful integration.
      // These are best-effort operations: if they fail, we log but don't fail the integration.
      try {
        await removeGitWorktree(workspace.repositoryRoot, workspace.worktreePath);
      } catch (error) {
        console.error(
          `[orchestration] Failed to remove worktree for task ${row.task_id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      try {
        await deleteGitBranch(workspace.repositoryRoot, workspace.branchName);
      } catch (error) {
        console.error(
          `[orchestration] Failed to delete branch for task ${row.task_id}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }

      // The integrated changes are now safe: release the task's writable files
      // and immediately reschedule so waiting/dependent work can continue.
      this.leases.releaseTask(row.task_id, 'The task changes were integrated successfully.');
      // Waiting tasks may belong to another session of the same project, so the
      // whole backend is rescheduled under the configured limits.
      await this.scheduleAll().catch(() => undefined);
    } catch (error) {
      fail(
        'failed',
        'integration_failed',
        error instanceof ApiError
          ? error.message
          : 'The integration failed unexpectedly. The source branch and worktree were preserved.',
      );
    }
  }

  /** Force-releases all active leases for a task. Admin operation. */
  forceReleaseLeases(taskId: string, reason: string): number {
    return this.leases.forceReleaseTask(taskId, reason);
  }

  /** Deletes a task and its associated data. Admin operation. */
  deleteTask(taskId: string): void {
    this.db
      .prepare(`DELETE FROM agent_tasks WHERE id = ?`)
      .run(taskId);
  }

  /**
   * Returns the git diff for a task's worktree — shows what the agent has changed.
   * Includes both uncommitted changes and committed changes on the task branch.
   */
  async getTaskDiff(taskId: string): Promise<{ diff: string; worktreePath: string | null; branchName: string | null }> {
    const task = this.getTask(taskId);
    const worktreePath = task.worktreePath;
    const branchName = task.branchName;

    if (!worktreePath) {
      return { diff: '', worktreePath: null, branchName };
    }

    const fs = await import('node:fs');
    if (!fs.existsSync(worktreePath)) {
      return { diff: '', worktreePath, branchName };
    }

    const { runGitCommand } = await import('./gitWorkspaces.js');
    try {
      // Get uncommitted changes + committed changes vs base
      const diff = await runGitCommand(worktreePath, ['diff', 'HEAD', '--', '.']);
      return { diff: diff.stdout.trim(), worktreePath, branchName };
    } catch {
      return { diff: '', worktreePath, branchName };
    }
  }
}
