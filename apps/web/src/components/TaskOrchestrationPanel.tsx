import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import { LIVE_POLL_INTERVAL_MS } from '../lib/constants';
import type {
  AgentTaskSummary,
  OrchestrationSettings,
  SessionOrchestrationSummary,
  SessionSummary,
  ValidationCommandConfig,
} from '../lib/types';
import { CoordinationState } from './CoordinationState';
import { Notice } from './Notice';
import {
  OrchestrationSettingsForm,
  type CommandDraft,
  type SettingsDraft,
} from './OrchestrationSettingsForm';
import { OrchestrationToolbar } from './OrchestrationToolbar';
import { TaskCard, type TaskEditDraft, type TaskLogs } from './TaskCard';

interface TaskOrchestrationPanelProps {
  session: SessionSummary;
  onSessionChanged: (session: SessionSummary) => void;
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
    const timer = window.setInterval(() => void load(), LIVE_POLL_INTERVAL_MS);
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
  const hasLiveTerminals = session.terminals.some(
    (terminal) => terminal.status === 'running' || terminal.status === 'starting',
  );

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
    <section className="flex flex-col gap-3" data-testid="task-orchestration">
      <OrchestrationToolbar
        summary={summary}
        capacity={capacity}
        busyKey={busyKey}
        onSchedule={() => void schedule()}
        onProcessQueue={() => void processQueue()}
        onToggleScheduling={() => void toggleScheduling()}
        onRefresh={() => void load()}
      />

      {summary?.sharedFolderRisk ? (
        <Notice
          tone="warn"
          action={{
            label: 'Convert to isolated worktrees',
            onClick: () => void isolate(),
            disabled: busyKey !== null || hasLiveTerminals,
            icon: busyKey === 'isolate' ? Loader2 : undefined,
          }}
        >
          <div data-testid="shared-folder-warning">
            <p>Convert this session to isolated Git worktrees to run concurrent agents.</p>
            {hasLiveTerminals ? (
              <p className="mt-1 text-muted">Stop every terminal first.</p>
            ) : null}
          </div>
        </Notice>
      ) : null}

      {summary?.schedulingPaused ? (
        <Notice tone="warn">
          <span data-testid="scheduling-paused">
            Scheduling is paused for this project. Running agents keep their worktrees and leases;
            no new task is launched or resumed until you press Resume scheduling.
          </span>
        </Notice>
      ) : null}

      <CoordinationState summary={summary} session={session} />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      {actionError ? <Notice tone="danger">{actionError}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <OrchestrationSettingsForm
        settings={settings}
        draft={draft}
        open={settingsOpen}
        busyKey={busyKey}
        onToggle={(open) => {
          setSettingsOpen(open);
          if (open && summary && !draft) setDraft(toDraft(summary.settings));
        }}
        onDraftChange={updateDraft}
        onCommandChange={updateCommand}
        onSave={() => void saveSettings()}
      />

      {tasks.length === 0 ? (
        <p className="text-[11px] text-muted">
          No agent tasks in this session yet. Assign a task to a terminal, then schedule it here.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {tasks.map((task) => {
            const terminal = terminalFor(session, task.id);
            const live = isTerminalLive(session, task.id);
            return (
              <TaskCard
                key={task.id}
                task={task}
                tasks={tasks}
                terminal={terminal}
                live={live}
                selected={selectedTaskId === task.id}
                busyKey={busyKey}
                completionSummary={completionSummary}
                acknowledgeNoValidation={acknowledgeNoValidation}
                allowOutOfScope={allowOutOfScope}
                editDraft={editDraft}
                logs={logs}
                onSelect={() => selectTask(task.id)}
                onCompletionSummaryChange={setCompletionSummary}
                onAcknowledgeNoValidationChange={setAcknowledgeNoValidation}
                onAllowOutOfScopeChange={setAllowOutOfScope}
                onComplete={() => void completeTask(task)}
                onValidate={() => void validateTask(task)}
                onIntegrate={() => void integrateTask(task)}
                onRetry={() => void retryTask(task)}
                onReplan={() => void replanTask(task)}
                onStartEdit={() => startEdit(task)}
                onCancelValidation={() => void cancelValidation(task)}
                onCancel={() => void cancelTask(task)}
                onSaveAssignment={() => void saveAssignment(task)}
                onEditDraftChange={setEditDraft}
                onEditCancel={() => setEditDraft(null)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
