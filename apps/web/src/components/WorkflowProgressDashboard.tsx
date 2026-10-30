import { Play } from 'lucide-react';
import { briefText, taskTitle } from '../lib/format';
import type {
  SessionOrchestrationSummary,
  SessionSummary,
  WorkflowSummary,
} from '../lib/types';
import { Notice } from './Notice';
import { StatStrip } from './StatStrip';

interface WorkflowProgressDashboardProps {
  summary: SessionOrchestrationSummary;
  workflow: WorkflowSummary;
  session: SessionSummary | null;
  paused: boolean;
  sharedFolderRisk: boolean;
  busy: boolean;
  statusError: string | null;
  onResume: () => void;
}

function taskStateLabel(task: SessionOrchestrationSummary['tasks'][number]): string {
  if (task.state === 'running') return 'Working';
  if (task.state === 'validating') return 'Checking changes';
  if (task.state === 'awaiting_integration') return 'Ready for review';
  if (task.state === 'integrated') return 'Completed';
  if (task.state === 'failed') return 'Needs your attention';
  if (task.state === 'cancelled') return 'Cancelled';
  if (task.state === 'blocked') {
    if (task.waitKind === 'files') return 'Waiting for a file';
    if (task.waitKind === 'dependency') return 'Waiting for another task';
    return 'Blocked';
  }
  return task.state === 'unassigned' ? 'Not started' : 'Queued';
}

function workflowStatus(
  summary: SessionOrchestrationSummary,
  workflow: WorkflowSummary,
): string {
  const states = summary.tasks.map((task) => task.state);
  if (summary.schedulingPaused || workflow.status === 'paused') return 'paused';
  if (states.includes('failed')) return 'needs your attention';
  if (states.length > 0 && states.every((state) => state === 'integrated')) return 'completed';
  if (states.length > 0 && states.every((state) => state === 'cancelled')) return 'cancelled';
  if (
    states.includes('awaiting_integration') &&
    states.every((state) => ['integrated', 'awaiting_integration'].includes(state))
  ) {
    return 'awaiting integration';
  }
  if (states.includes('running') || states.includes('validating')) return 'running';
  if (states.some((state) => ['unassigned', 'blocked', 'ready', 'assigned'].includes(state))) {
    return 'queued';
  }
  return workflow.status;
}

export function WorkflowProgressDashboard({
  summary,
  workflow,
  session,
  paused,
  sharedFolderRisk,
  busy,
  statusError,
  onResume,
}: WorkflowProgressDashboardProps) {
  const tasks = summary.tasks;
  const runningCount = tasks.filter((task) => task.state === 'running').length;
  const validatingCount = tasks.filter((task) => task.state === 'validating').length;
  const queuedCount = tasks.filter((task) => ['ready', 'assigned'].includes(task.state)).length;
  const waitingCount = tasks.filter((task) => task.state === 'blocked').length;
  const integrationCount = tasks.filter((task) => task.state === 'awaiting_integration').length;
  const failedCount = tasks.filter((task) => task.state === 'failed').length;
  const completedCount = tasks.filter((task) => task.state === 'integrated').length;
  const cancelledCount = tasks.filter((task) => task.state === 'cancelled').length;
  const needsAttention =
    failedCount > 0 ||
    tasks.some((task) => {
      const terminal = session?.terminals.find((entry) => entry.id === task.id);
      return terminal?.status === 'error' || terminal?.status === 'unavailable';
    });

  return (
    <div className="border-t border-line pt-3 text-xs" data-testid="workflow-progress">
      <p className="font-medium text-ink">
        {needsAttention
          ? 'Needs your attention'
          : paused
            ? 'Workflow paused'
            : sharedFolderRisk
              ? 'Safe workspaces required'
              : `Workflow ${workflowStatus(summary, workflow)}`}
        {' · '}
        {workflow.plan.tasks.length} agent task(s)
      </p>
      <div className="mt-2">
        <StatStrip
          columns={8}
          items={[
            { label: 'Working', value: String(runningCount) },
            { label: 'Queued', value: String(queuedCount) },
            { label: 'Waiting', value: String(waitingCount) },
            { label: 'Checking', value: String(validatingCount) },
            { label: 'Review', value: String(integrationCount) },
            { label: 'Completed', value: String(completedCount) },
            { label: 'Attention', value: String(failedCount) },
            { label: 'Cancelled', value: String(cancelledCount) },
          ]}
        />
      </div>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {tasks.map((task) => {
          const terminal = session?.terminals.find((entry) => entry.id === task.id);
          const failedTerminal =
            terminal?.status === 'error' || terminal?.status === 'unavailable';
          return (
            <li
              key={task.id}
              className={`rounded border px-2 py-1.5 ${
                task.state === 'failed' || failedTerminal
                  ? 'border-danger bg-danger-soft'
                  : 'border-line bg-panel'
              }`}
            >
              <p className="font-medium text-ink">
                {taskTitle(task.description) || task.agentName}
              </p>
              <p className="mt-0.5 text-muted">
                {briefText(
                  task.completionSummary ??
                    task.blockedReason ??
                    terminal?.lastError ??
                    (failedTerminal || task.state === 'failed'
                      ? 'This task stopped before completion and needs attention.'
                      : task.state === 'integrated'
                        ? 'The changes were integrated successfully.'
                        : task.state === 'awaiting_integration'
                          ? 'Validation finished; changes are ready for review.'
                          : task.state === 'validating'
                            ? 'Configured checks are running.'
                            : terminal?.status === 'running'
                              ? 'The agent is working on its assigned changes.'
                              : task.waitKind === 'files'
                                ? 'Waiting for a file another agent is using.'
                                : task.waitKind === 'dependency'
                                  ? 'Waiting for another task to finish.'
                                  : 'This task has not started yet.'),
                )}
              </p>
              <p className="text-muted">
                {terminal?.toolName ?? task.agentName} ·{' '}
                {failedTerminal ? 'Needs your attention' : taskStateLabel(task)}
              </p>
              {task.waitKind ? (
                <p className="mt-0.5 text-muted">
                  {task.waitKind === 'dependency'
                    ? 'Waiting for another task to finish.'
                    : 'Waiting for a file another agent is using.'}
                </p>
              ) : null}
              {task.state === 'failed' || failedTerminal ? (
                <p className="mt-0.5 text-danger">
                  {briefText(
                    terminal?.lastError ??
                      task.blockedReason ??
                      task.integrationReason ??
                      'The agent needs attention.',
                  )}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {paused ? (
        <Notice
          tone="warn"
          action={{
            label: 'Resume workflow',
            onClick: onResume,
            disabled: busy,
            icon: Play,
          }}
        >
          No new tasks will start until scheduling resumes.
        </Notice>
      ) : null}
      {statusError ? (
        <Notice tone="warn">Showing last confirmed status: {statusError}</Notice>
      ) : null}
    </div>
  );
}
