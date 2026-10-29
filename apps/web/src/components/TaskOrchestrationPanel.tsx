import {
  AlertTriangle,
  FileLock2,
  GitMerge,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import { TaskStateBadge } from './Badge';
import type {
  AgentTaskSummary,
  OrchestrationSettings,
  SessionOrchestrationSummary,
  SessionSummary,
  TaskIntegrationAttempt,
  TaskValidationResult,
  ValidationCommandConfig,
} from '../lib/types';

interface TaskOrchestrationPanelProps {
  session: SessionSummary;
  onSessionChanged: (session: SessionSummary) => void;
}

interface CommandDraft {
  key: string;
  name: string;
  command: string;
  args: string;
  timeoutSeconds: string;
  required: boolean;
}

interface SettingsDraft {
  autoIntegrate: boolean;
  maxConcurrentAgents: number;
  targetBranch: string;
  protectedPaths: string;
  commands: CommandDraft[];
}

interface TaskLogs {
  validations: TaskValidationResult[];
  integrations: TaskIntegrationAttempt[];
}

function draftKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `row-${Math.random().toString(36).slice(2)}`;
}

function toDraft(settings: OrchestrationSettings): SettingsDraft {
  return {
    autoIntegrate: settings.autoIntegrate,
    maxConcurrentAgents: settings.maxConcurrentAgents,
    targetBranch: settings.targetBranch ?? '',
    protectedPaths: settings.protectedPaths.join('\n'),
    commands: settings.validationCommands.map((command) => ({
      key: draftKey(),
      name: command.name,
      command: command.command,
      args: command.args.join('\n'),
      timeoutSeconds: String(Math.round(command.timeoutMs / 1000)),
      required: command.required,
    })),
  };
}

function toCommands(draft: SettingsDraft): ValidationCommandConfig[] {
  return draft.commands.map((row, index) => ({
    name: row.name.trim() || `check ${index + 1}`,
    command: row.command.trim(),
    args: row.args
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
    required: row.required,
    timeoutMs: Math.max(1, Number(row.timeoutSeconds) || 300) * 1000,
  }));
}

function terminalFor(session: SessionSummary, taskId: string) {
  return session.terminals.find((terminal) => terminal.id === taskId) ?? null;
}

function isTerminalLive(session: SessionSummary, taskId: string): boolean {
  const terminal = terminalFor(session, taskId);
  return terminal?.status === 'running' || terminal?.status === 'starting';
}

function briefText(value: string, maxLength = 140): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function taskTitle(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s+/)[0] ?? description;
  return briefText(firstSentence, 78) || 'Untitled agent task';
}

interface TaskEditDraft {
  taskId: string;
  description: string;
  scope: string;
}

export function TaskOrchestrationPanel({
  session,
  onSessionChanged,
}: TaskOrchestrationPanelProps) {
  const [summary, setSummary] = useState<SessionOrchestrationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [completionSummary, setCompletionSummary] = useState('');
  const [acknowledgeNoValidation, setAcknowledgeNoValidation] = useState(false);
  const [allowOutOfScope, setAllowOutOfScope] = useState(false);
  const [logs, setLogs] = useState<TaskLogs | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [editDraft, setEditDraft] = useState<TaskEditDraft | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await apiGet<{ orchestration: SessionOrchestrationSummary }>(
        `/api/orchestration/sessions/${session.id}`,
      );
      if (requestId !== requestRef.current) return;
      setSummary(result.orchestration);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(
        error instanceof Error ? error.message : 'Task orchestration state could not be loaded.',
      );
    }
  }, [session.id]);

  const loadLogs = useCallback(async (taskId: string) => {
    try {
      const result = await apiGet<{ logs: TaskLogs }>(`/api/orchestration/tasks/${taskId}`);
      setLogs(result.logs);
    } catch {
      setLogs(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (settingsOpen && summary && !draft) setDraft(toDraft(summary.settings));
  }, [settingsOpen, summary, draft]);

  useEffect(() => {
    setSelectedTaskId(null);
    setLogs(null);
    setCompletionSummary('');
    setAcknowledgeNoValidation(false);
    setAllowOutOfScope(false);
    setActionError(null);
    setNotice(null);
    setSettingsOpen(false);
    setDraft(null);
    setEditDraft(null);
  }, [session.id]);

  const run = async (key: string, operation: () => Promise<string | null>) => {
    setBusyKey(key);
    setActionError(null);
    setNotice(null);
    try {
      const message = await operation();
      setNotice(message);
      await load();
      if (selectedTaskId) await loadLogs(selectedTaskId);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'The orchestration action failed.',
      );
      await load();
    } finally {
      setBusyKey(null);
    }
  };

  const settings = summary?.settings ?? null;
  const capacity = summary?.capacity ?? null;
  const tasks = summary?.tasks ?? [];

  const selectTask = (taskId: string) => {
    if (selectedTaskId === taskId) {
      setSelectedTaskId(null);
      setLogs(null);
      return;
    }
    setSelectedTaskId(taskId);
    setCompletionSummary('');
    setAcknowledgeNoValidation(false);
    setAllowOutOfScope(false);
    void loadLogs(taskId);
  };

  const toggleScheduling = () =>
    run('scheduling', async () => {
      const paused = !(summary?.schedulingPaused ?? false);
      const result = await apiPost<{ orchestration: SessionOrchestrationSummary }>(
        `/api/orchestration/sessions/${session.id}/scheduling`,
        { paused },
      );
      setSummary(result.orchestration);
      return paused
        ? 'Scheduling paused. Running agents keep their files and no new task is launched.'
        : 'Scheduling resumed. Eligible tasks were evaluated again.';
    });

  const replanTask = (task: AgentTaskSummary) =>
    run(`replan:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/replan`,
        {},
      );
      return `Replanned scope: ${result.task.declaredFileScope.join(', ') || 'none'}. Deferred: ${
        result.task.deferredScope.join(', ') || 'none'
      }.`;
    });

  const startEdit = (task: AgentTaskSummary) => {
    setEditDraft({
      taskId: task.id,
      description: task.description,
      scope: task.declaredFileScope.join('\n'),
    });
  };

  const saveAssignment = (task: AgentTaskSummary) =>
    run(`edit:${task.id}`, async () => {
      if (!editDraft) return null;
      const result = await apiPatch<{ session: SessionSummary }>(
        `/api/sessions/${session.id}/terminals/${task.id}/task`,
        {
          description: editDraft.description,
          declaredFileScope: editDraft.scope
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
      );
      onSessionChanged(result.session);
      setEditDraft(null);
      return 'Plan updated. The task was returned to the scheduler with its new writable scope.';
    });

  const schedule = () =>
    run('schedule', async () => {
      const result = await apiPost<{
        result: { scheduled: string[]; skipped: Array<{ taskId: string; reason: string }> };
      }>(`/api/orchestration/sessions/${session.id}/schedule`);
      const { scheduled, skipped } = result.result;
      const blocker = skipped.find((entry) => entry.reason)?.reason;
      return `${scheduled.length} task(s) started.${
        blocker && scheduled.length === 0 ? ` First blocker: ${blocker}` : ''
      }`;
    });

  const processQueue = () =>
    run('queue', async () => {
      await apiPost('/api/orchestration/queue/process');
      return 'Integration queue processed.';
    });

  const isolate = () =>
    run('isolate', async () => {
      const result = await apiPost<{ session: SessionSummary }>(
        `/api/orchestration/sessions/${session.id}/isolate`,
      );
      onSessionChanged(result.session);
      return 'Session converted to isolated worktrees. Files in the shared folder were not moved.';
    });

  const completeTask = (task: AgentTaskSummary) =>
    run(`complete:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/complete`,
        { summary: completionSummary },
      );
      setCompletionSummary('');
      return `Completion recorded for ${task.id.slice(0, 8)}. Current state: ${result.task.state}.`;
    });

  const validateTask = (task: AgentTaskSummary) =>
    run(`validate:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/validate`,
      );
      return `Validation finished: ${result.task.validationStatus}. ${result.task.validationSummary ?? ''}`;
    });

  const integrateTask = (task: AgentTaskSummary) =>
    run(`integrate:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/integrate`,
        { acknowledgeNoValidation, allowOutOfScope },
      );
      return result.task.integrationCommit
        ? `Integrated as ${result.task.integrationCommit.slice(0, 12)} on ${result.task.targetBranch}.`
        : `Integration state: ${result.task.integrationStatus}.`;
    });

  const retryTask = (task: AgentTaskSummary) =>
    run(`retry:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/retry`,
      );
      return `Task returned to ${result.task.state}.`;
    });

  const cancelTask = (task: AgentTaskSummary) =>
    run(`cancel:${task.id}`, async () => {
      const result = await apiPost<{ task: AgentTaskSummary }>(
        `/api/orchestration/tasks/${task.id}/cancel`,
      );
      return `Task state: ${result.task.state}.`;
    });

  const cancelValidation = (task: AgentTaskSummary) =>
    run(`cancel-validation:${task.id}`, async () => {
      const result = await apiPost<{ cancelled: boolean }>(
        `/api/orchestration/tasks/${task.id}/cancel-validation`,
      );
      return result.cancelled ? 'Validation cancellation requested.' : 'No validation was running.';
    });

  const saveSettings = () =>
    run('settings', async () => {
      if (!draft) return null;
      const result = await apiPut<{ settings: OrchestrationSettings }>(
        '/api/orchestration/settings',
        {
          projectId: session.project.id,
          autoIntegrate: draft.autoIntegrate,
          maxConcurrentAgents: draft.maxConcurrentAgents,
          targetBranch: draft.targetBranch.trim() ? draft.targetBranch.trim() : null,
          protectedPaths: draft.protectedPaths
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean),
          validationCommands: toCommands(draft),
        },
      );
      setDraft(toDraft(result.settings));
      return 'Project orchestration settings saved.';
    });

  const updateDraft = (patch: Partial<SettingsDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const updateCommand = (key: string, patch: Partial<CommandDraft>) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            commands: current.commands.map((row) =>
              row.key === key ? { ...row, ...patch } : row,
            ),
          }
        : current,
    );
  };

  return (
    <section className="panel flex flex-col gap-3 p-3" data-testid="task-orchestration">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GitMerge className="h-4 w-4 shrink-0 text-muted" />
          <span className="text-sm font-medium text-ink">Task orchestration</span>
          {capacity ? (
            <span className="text-[11px] text-muted">
              agents {capacity.activeAgents}/{capacity.maxConcurrentAgents} · live terminals{' '}
              {capacity.liveTerminals}/{capacity.maxLiveTerminals} · backend cap{' '}
              {capacity.systemMaxConcurrentAgents}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn px-2.5 py-1.5 text-xs"
            onClick={() => void schedule()}
            disabled={busyKey !== null}
            data-testid="orchestration-schedule"
          >
            {busyKey === 'schedule' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Schedule ready tasks
          </button>
          <button
            type="button"
            className="btn px-2.5 py-1.5 text-xs"
            onClick={() => void processQueue()}
            disabled={busyKey !== null}
            data-testid="orchestration-process-queue"
          >
            {busyKey === 'queue' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            Run integration queue
          </button>
          <button
            type="button"
            className="btn px-2.5 py-1.5 text-xs"
            onClick={() => void toggleScheduling()}
            disabled={busyKey !== null || !summary}
            data-testid="orchestration-pause"
          >
            {busyKey === 'scheduling' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : summary?.schedulingPaused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            {summary?.schedulingPaused ? 'Resume scheduling' : 'Pause scheduling'}
          </button>
          <button
            type="button"
            className="btn px-2.5 py-1.5 text-xs"
            onClick={() => void load()}
            aria-label="Refresh orchestration state"
            data-testid="orchestration-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {summary?.sharedFolderRisk ? (
        <div
          className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[11px] text-ink"
          data-testid="shared-folder-warning"
        >
          <p className="flex items-start gap-1.5 font-medium text-warn">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Shared Folder mode: {session.terminals.length} terminals write to the same directory, so
            agent tasks cannot run there safely and are blocked.
          </p>
          <p className="mt-1 text-muted">
            Convert this session to isolated Git worktrees to run concurrent agents. The conversion
            requires a stopped session inside a clean Git repository; files in the shared folder are
            never moved or deleted.
          </p>
          <button
            type="button"
            className="btn mt-2 px-2.5 py-1.5 text-xs"
            onClick={() => void isolate()}
            disabled={busyKey !== null || session.terminals.some((terminal) => terminal.status === 'running' || terminal.status === 'starting')}
            data-testid="isolate-session"
          >
            {busyKey === 'isolate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Convert to isolated worktrees
          </button>
          {session.terminals.some(
            (terminal) => terminal.status === 'running' || terminal.status === 'starting',
          ) ? (
            <span className="ml-2 text-[11px] text-muted">Stop every terminal first.</span>
          ) : null}
        </div>
      ) : null}

      {summary?.schedulingPaused ? (
        <p
          className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[11px] text-warn"
          data-testid="scheduling-paused"
        >
          Scheduling is paused for this project. Running agents keep their worktrees and leases; no
          new task is launched or resumed until you press Resume scheduling.
        </p>
      ) : null}

      <div className="grid gap-2 text-[11px] md:grid-cols-2" data-testid="coordination-state">
        <div className="rounded-lg border border-line bg-panel-2 p-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-ink">
            <FileLock2 className="h-3.5 w-3.5 text-muted" />
            Writable file ownership
            <span className="text-muted">({summary?.leases.length ?? 0} active)</span>
          </div>
          {!summary || summary.leases.length === 0 ? (
            <p className="mt-1 text-muted">No task currently owns a writable scope.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-muted">
              {summary.leases.map((lease) => (
                <li key={`${lease.taskId}:${lease.path}`}>
                  <span className="mono text-ink">
                    {lease.path}
                    {lease.isDirectory ? '/' : ''}
                  </span>{' '}
                  · {lease.agentName} · {lease.taskLabel} ({lease.taskState})
                  {lease.reason ? ` · ${lease.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted">
            {session.workspaceMode === 'shared'
              ? 'Shared Folder mode: leases are advisory only. Another CLI writing directly into this folder is not technically blocked.'
              : 'Isolated worktrees: another task cannot claim the same file, or a directory containing it, at the same time.'}
          </p>
        </div>
        <div className="rounded-lg border border-line bg-panel-2 p-2.5">
          <div className="flex items-center gap-2 text-xs font-medium text-ink">
            <ListChecks className="h-3.5 w-3.5 text-muted" />
            Waiting queue
            <span className="text-muted">({summary?.waiting.length ?? 0})</span>
          </div>
          {!summary || summary.waiting.length === 0 ? (
            <p className="mt-1 text-muted">No task is waiting for files or dependencies.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-0.5 text-muted">
              {summary.waiting.map((entry) => {
                const waitingTask = summary.tasks.find((task) => task.id === entry.taskId);
                return (
                  <li key={entry.taskId}>
                    <span className="text-ink">
                      {entry.kind === 'files' ? 'Waiting for file' : 'Blocked by dependency'}
                    </span>{' '}
                    · {waitingTask?.description || entry.taskId.slice(0, 8)} · {entry.reason}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-xs text-ink">
          {loadError}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-xs text-ink">
          {actionError}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-line bg-ok-soft px-3 py-2 text-xs text-ink">{notice}</p>
      ) : null}

      <details
        className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11px] text-muted"
        open={settingsOpen}
        onToggle={(event) => {
          const open = (event.currentTarget as HTMLDetailsElement).open;
          setSettingsOpen(open);
          if (open && summary && !draft) setDraft(toDraft(summary.settings));
        }}
      >
        <summary className="cursor-pointer text-xs font-medium text-muted">
          Project orchestration settings (validation checks, integration, concurrency)
        </summary>
        {draft && settings ? (
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex items-center gap-2 text-ink">
              <input
                type="checkbox"
                checked={draft.autoIntegrate}
                onChange={(event) => updateDraft({ autoIntegrate: event.target.checked })}
                data-testid="auto-integrate"
              />
              Integrate completed tasks automatically after all required checks pass
            </label>
            <p className="text-[11px] text-muted">
              Off by default. When disabled, completed tasks wait in the integration queue until you
              press Integrate.
            </p>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-[11px] text-muted">
                Maximum concurrent agents for this project (backend cap {settings.systemMaxConcurrentAgents})
                <input
                  type="number"
                  min={1}
                  max={settings.systemMaxConcurrentAgents}
                  className="input mt-1"
                  value={draft.maxConcurrentAgents}
                  onChange={(event) =>
                    updateDraft({ maxConcurrentAgents: Number(event.target.value) || 1 })
                  }
                  data-testid="max-concurrent-agents"
                />
              </label>
              <label className="text-[11px] text-muted">
                Integration target branch (blank uses {settings.resolvedTargetBranch})
                <input
                  className="input mt-1 mono"
                  value={draft.targetBranch}
                  placeholder={settings.resolvedTargetBranch}
                  onChange={(event) => updateDraft({ targetBranch: event.target.value })}
                  data-testid="target-branch"
                />
              </label>
            </div>

            <label className="text-[11px] text-muted">
              Protected paths (one repository-relative path per line; changes there are never
              integrated)
              <textarea
                className="input mt-1 min-h-16 w-full font-mono"
                value={draft.protectedPaths}
                onChange={(event) => updateDraft({ protectedPaths: event.target.value })}
                data-testid="protected-paths"
              />
            </label>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-ink">Validation checks</span>
              {draft.commands.length === 0 ? (
                <p className="text-[11px] text-muted">
                  No checks configured. Integration then requires an explicit acknowledgement that
                  nothing was validated.
                </p>
              ) : null}
              {draft.commands.map((row) => (
                <div
                  key={row.key}
                  className="grid gap-1.5 rounded-lg border border-line bg-app p-2 md:grid-cols-2"
                >
                  <input
                    className="input"
                    placeholder="Check name (for example typecheck)"
                    value={row.name}
                    onChange={(event) => updateCommand(row.key, { name: event.target.value })}
                  />
                  <input
                    className="input mono"
                    placeholder="node, npm, or an absolute executable path"
                    value={row.command}
                    onChange={(event) => updateCommand(row.key, { command: event.target.value })}
                  />
                  <textarea
                    className="input min-h-16 font-mono md:col-span-2"
                    placeholder="One argument per line, for example:&#10;run&#10;typecheck"
                    value={row.args}
                    onChange={(event) => updateCommand(row.key, { args: event.target.value })}
                  />
                  <label className="flex items-center gap-2 text-[11px] text-muted">
                    Timeout (seconds)
                    <input
                      type="number"
                      min={1}
                      className="input w-24"
                      value={row.timeoutSeconds}
                      onChange={(event) =>
                        updateCommand(row.key, { timeoutSeconds: event.target.value })
                      }
                    />
                  </label>
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-[11px] text-muted">
                      <input
                        type="checkbox"
                        checked={row.required}
                        onChange={(event) =>
                          updateCommand(row.key, { required: event.target.checked })
                        }
                      />
                      Required before integration
                    </label>
                    <button
                      type="button"
                      className="btn px-2 py-1 text-xs"
                      onClick={() =>
                        updateDraft({
                          commands: draft.commands.filter((entry) => entry.key !== row.key),
                        })
                      }
                      aria-label="Remove this validation check"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="btn w-fit px-2.5 py-1.5 text-xs"
                onClick={() =>
                  updateDraft({
                    commands: [
                      ...(draft?.commands ?? []),
                      {
                        key: draftKey(),
                        name: '',
                        command: 'node',
                        args: '',
                        timeoutSeconds: '300',
                        required: true,
                      },
                    ],
                  })
                }
              >
                <Plus className="h-3.5 w-3.5" />
                Add validation check
              </button>
            </div>

            <button
              type="button"
              className="btn btn-primary w-fit px-3 py-1.5 text-xs"
              onClick={() => void saveSettings()}
              disabled={busyKey !== null}
              data-testid="save-orchestration-settings"
            >
              {busyKey === 'settings' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save settings
            </button>
          </div>
        ) : null}
      </details>

      {tasks.length === 0 ? (
        <p className="text-[11px] text-muted">
          No agent tasks in this session yet. Assign a task to a terminal, then schedule it here.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => {
            const terminal = terminalFor(session, task.id);
            const live = isTerminalLive(session, task.id);
            const isSelected = selectedTaskId === task.id;
            return (
              <div
                key={task.id}
                className="rounded-lg border border-line bg-panel-2 p-2.5 text-[11px]"
                data-testid={`orchestration-task-${task.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <TaskStateBadge state={task.state} />
                      <span className="text-xs font-medium text-ink">
                        {taskTitle(task.description)}
                      </span>
                      <span className="text-muted">
                        {terminal ? `${terminal.toolName} · ${terminal.status}` : 'terminal missing'}
                      </span>
                    </div>
                    {task.completionSummary || task.blockedReason ? (
                      <p className="mt-1 text-muted">
                        {briefText(task.completionSummary ?? task.blockedReason ?? '')}
                      </p>
                    ) : null}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted">Advanced task details</summary>
                      <div className="mt-1 flex flex-col gap-0.5 text-muted">
                        <p className="whitespace-pre-wrap text-ink">
                          {task.description || 'No task description'}
                        </p>
                        {task.blockedReason ? <p>Blocked: {task.blockedReason}</p> : null}
                        <span>
                          Agent <span className="text-ink">{task.agentName}</span>
                          {' · '}
                          {task.dependencies.length === 0
                            ? 'independent'
                            : `depends on ${task.dependencies
                                .map((dependencyId) => {
                                  const dependency = tasks.find((entry) => entry.id === dependencyId);
                                  return dependency
                                    ? taskTitle(dependency.description)
                                    : dependencyId.slice(0, 8);
                                })
                                .join(', ')}`}
                          {task.waitKind
                            ? ` · ${task.waitKind === 'files' ? 'waiting for file' : 'blocked by dependency'}`
                            : ''}
                        </span>
                        {task.scopeViolations.length > 0 ? (
                          <span className="text-warn">
                            Changes outside the declared scope:{' '}
                            <span className="mono">{task.scopeViolations.join(', ')}</span>
                          </span>
                        ) : null}
                        {task.branchName ? (
                          <span>
                            branch <span className="mono text-ink">{task.branchName}</span>
                            {task.worktreePath ? (
                              <>
                                {' '}
                                in <span className="mono">{task.worktreePath}</span>
                              </>
                            ) : null}
                          </span>
                        ) : null}
                        <span>
                          scope{' '}
                          <span className="mono text-ink">
                            {task.declaredFileScope.join(', ') || 'not declared'}
                          </span>
                          {task.actualFiles.length > 0 ? (
                            <>
                              {' '}
                              · changed{' '}
                              <span className="mono text-ink">{task.actualFiles.join(', ')}</span>
                            </>
                          ) : null}
                        </span>
                        {task.deferredScope.length > 0 ? (
                          <span>
                            deferred scope{' '}
                            <span className="mono text-ink">{task.deferredScope.join(', ')}</span>
                            {` · replanned ${task.replanCount}x`}
                          </span>
                        ) : null}
                        {task.leases.length > 0 ? (
                          <span>
                            owns{' '}
                            <span className="mono text-ink">
                              {task.leases
                                .map((lease) => `${lease.path}${lease.isDirectory ? '/' : ''}`)
                                .join(', ')}
                            </span>
                          </span>
                        ) : null}
                        {task.targetBranch ? <span>target {task.targetBranch}</span> : null}
                        {task.integrationCommit ? (
                          <span>
                            Integrated commit{' '}
                            <span className="mono text-ink">{task.integrationCommit}</span>
                            {task.completedAt ? ` · completed ${task.completedAt}` : ''}
                          </span>
                        ) : null}
                      </div>
                    </details>
                  </div>
                  <button
                    type="button"
                    className="btn shrink-0 px-2 py-1 text-xs"
                    onClick={() => selectTask(task.id)}
                    data-testid={`orchestration-task-actions-${task.id}`}
                  >
                    {isSelected ? 'Hide actions' : 'Actions'}
                  </button>
                </div>

                {task.scopeViolations.length > 0 ? (
                  <p className="mt-1.5 rounded border border-line bg-warn-soft px-2 py-1 text-warn">
                    Changes outside the declared scope. Review Advanced task details for affected
                    paths.
                  </p>
                ) : null}
                {task.validationSummary ? (
                  <p className="mt-1.5 text-muted">
                    Validation ({task.validationStatus}): {briefText(task.validationSummary)}
                  </p>
                ) : null}
                {task.integrationReason ? (
                  <p className="mt-1.5 rounded border border-line bg-danger-soft px-2 py-1 text-ink">
                    Integration ({task.integrationStatus}): {briefText(task.integrationReason)}
                  </p>
                ) : null}

                {isSelected ? (
                  <div className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-app p-2">
                    <label className="text-[11px] text-muted">
                      Completion evidence (what the agent finished; required before validation and
                      integration)
                      <textarea
                        className="input mt-1 min-h-16 w-full"
                        maxLength={4000}
                        value={completionSummary}
                        placeholder="For example: implemented the settings API and committed it on the task branch."
                        onChange={(event) => setCompletionSummary(event.target.value)}
                      />
                    </label>
                    <label className="flex items-center gap-2 text-muted">
                      <input
                        type="checkbox"
                        checked={acknowledgeNoValidation}
                        onChange={(event) => setAcknowledgeNoValidation(event.target.checked)}
                      />
                      I understand no validation checks are configured for this project
                    </label>
                    <label className="flex items-center gap-2 text-muted">
                      <input
                        type="checkbox"
                        checked={allowOutOfScope}
                        onChange={(event) => setAllowOutOfScope(event.target.checked)}
                      />
                      I reviewed and approve the unexpected files listed above
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => void completeTask(task)}
                        disabled={busyKey !== null || !completionSummary.trim() || live}
                        title={
                          live
                            ? 'Stop the agent terminal before recording completion.'
                            : 'Record completion evidence and run configured checks.'
                        }
                      >
                        {busyKey === `complete:${task.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Record completion &amp; validate
                      </button>
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => void validateTask(task)}
                        disabled={busyKey !== null || !task.completedAt}
                      >
                        {busyKey === `validate:${task.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : null}
                        Re-run validation
                      </button>
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => void integrateTask(task)}
                        disabled={busyKey !== null || !task.completedAt}
                        data-testid={`orchestration-integrate-${task.id}`}
                      >
                        {busyKey === `integrate:${task.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <GitMerge className="h-3.5 w-3.5" />
                        )}
                        Integrate now
                      </button>
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => void retryTask(task)}
                        disabled={busyKey !== null}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
                      </button>
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => void replanTask(task)}
                        disabled={busyKey !== null || live || task.state === 'integrated'}
                        title="Narrow this task to writable files no other task owns and keep the rest deferred."
                        data-testid={`orchestration-replan-${task.id}`}
                      >
                        <FileLock2 className="h-3.5 w-3.5" />
                        Replan to free files
                      </button>
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs"
                        onClick={() => startEdit(task)}
                        disabled={busyKey !== null || live || task.state === 'integrated'}
                      >
                        <ListChecks className="h-3.5 w-3.5" />
                        Edit plan
                      </button>
                      {task.state === 'validating' ? (
                        <button
                          type="button"
                          className="btn px-2.5 py-1.5 text-xs"
                          onClick={() => void cancelValidation(task)}
                          disabled={busyKey !== null}
                        >
                          <Square className="h-3.5 w-3.5" />
                          Cancel validation
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-xs text-danger"
                        onClick={() => void cancelTask(task)}
                        disabled={busyKey !== null || task.state === 'integrated'}
                      >
                        <Square className="h-3.5 w-3.5" />
                        Cancel task
                      </button>
                    </div>

                    {editDraft?.taskId === task.id ? (
                      <div className="rounded-lg border border-line bg-panel p-2">
                        <label className="text-[11px] text-muted">
                          Task description
                          <textarea
                            className="input mt-1 min-h-14 w-full"
                            maxLength={4000}
                            value={editDraft.description}
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, description: event.target.value })
                            }
                          />
                        </label>
                        <label className="mt-1 block text-[11px] text-muted">
                          Writable scope (one repository-relative file or directory per line)
                          <textarea
                            className="input mt-1 min-h-14 w-full font-mono"
                            value={editDraft.scope}
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, scope: event.target.value })
                            }
                          />
                        </label>
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            type="button"
                            className="btn btn-primary px-2.5 py-1.5 text-xs"
                            onClick={() => void saveAssignment(task)}
                            disabled={busyKey !== null}
                          >
                            Save plan
                          </button>
                          <button
                            type="button"
                            className="btn px-2.5 py-1.5 text-xs"
                            onClick={() => setEditDraft(null)}
                            disabled={busyKey !== null}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {logs ? (
                      <div className="flex flex-col gap-1.5 text-[11px] text-muted">
                        <span className="font-medium text-ink">Validation log</span>
                        {logs.validations.length === 0 ? (
                          <span>No validation attempts yet.</span>
                        ) : (
                          logs.validations.map((entry) => (
                            <details key={entry.id} className="rounded border border-line bg-panel p-1.5">
                              <summary className="cursor-pointer">
                                {entry.name} · {entry.status}
                                {entry.exitCode !== null ? ` · exit ${entry.exitCode}` : ''}
                                {entry.durationMs !== null ? ` · ${entry.durationMs} ms` : ''}
                              </summary>
                              <pre className="mono mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">
                                {entry.command} {entry.args.join(' ')}
                                {'\n'}
                                {entry.output || '(no output)'}
                              </pre>
                            </details>
                          ))
                        )}
                        <span className="font-medium text-ink">Integration log</span>
                        {logs.integrations.length === 0 ? (
                          <span>No integration attempts yet.</span>
                        ) : (
                          logs.integrations.map((entry) => (
                            <div key={entry.id} className="rounded border border-line bg-panel p-1.5">
                              <span>
                                attempt {entry.attempt} · {entry.state} · target {entry.targetBranch}
                                {entry.mergeCommit ? ` · ${entry.mergeCommit.slice(0, 12)}` : ''}
                              </span>
                              {entry.reason ? <p className="mt-1 text-ink">{entry.reason}</p> : null}
                              {entry.changedFiles.length > 0 ? (
                                <p className="mono mt-1">{entry.changedFiles.join(', ')}</p>
                              ) : null}
                            </div>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
