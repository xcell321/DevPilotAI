import { briefText, taskTitle } from '../lib/format';
import type {
  AgentTaskSummary,
  SessionTerminal,
  TaskIntegrationAttempt,
  TaskValidationResult,
} from '../lib/types';
import { TaskStateBadge } from './Badge';
import { Notice } from './Notice';
import { TaskActionButtons } from './TaskCardActions';
import { TaskCardEditDraft } from './TaskCardEditDraft';
import { TaskCardLogs } from './TaskCardLogs';

export interface TaskLogs {
  validations: TaskValidationResult[];
  integrations: TaskIntegrationAttempt[];
}

export interface TaskEditDraft {
  taskId: string;
  description: string;
  scope: string;
}

export interface TaskActions {
  onComplete: () => void;
  onValidate: () => void;
  onIntegrate: () => void;
  onRetry: () => void;
  onReplan: () => void;
  onStartEdit: () => void;
  onCancelValidation: () => void;
  onCancel: () => void;
}

interface TaskCardProps {
  task: AgentTaskSummary;
  tasks: AgentTaskSummary[];
  terminal: SessionTerminal | null;
  live: boolean;
  selected: boolean;
  sessionId: string;
  busyKey: string | null;
  completionSummary: string;
  acknowledgeNoValidation: boolean;
  allowOutOfScope: boolean;
  editDraft: TaskEditDraft | null;
  logs: TaskLogs | null;
  onSelect: () => void;
  onCompletionSummaryChange: (value: string) => void;
  onAcknowledgeNoValidationChange: (value: boolean) => void;
  onAllowOutOfScopeChange: (value: boolean) => void;
  actions: TaskActions;
  onSaveAssignment: () => void;
  onEditDraftChange: (draft: TaskEditDraft) => void;
  onEditCancel: () => void;
}

interface TaskCardProps {
  task: AgentTaskSummary;
  tasks: AgentTaskSummary[];
  terminal: SessionTerminal | null;
  live: boolean;
  selected: boolean;
  sessionId: string;
  busyKey: string | null;
  completionSummary: string;
  acknowledgeNoValidation: boolean;
  allowOutOfScope: boolean;
  editDraft: TaskEditDraft | null;
  logs: TaskLogs | null;
  onSelect: () => void;
  onCompletionSummaryChange: (value: string) => void;
  onAcknowledgeNoValidationChange: (value: boolean) => void;
  onAllowOutOfScopeChange: (value: boolean) => void;
  actions: TaskActions;
  onSaveAssignment: () => void;
  onEditDraftChange: (draft: TaskEditDraft) => void;
  onEditCancel: () => void;
  /** Index for stagger delay */
  index?: number;
}

export function TaskCard({
  task,
  tasks,
  terminal,
  live,
  selected,
  sessionId,
  busyKey,
  completionSummary,
  acknowledgeNoValidation,
  allowOutOfScope,
  editDraft,
  logs,
  onSelect,
  onCompletionSummaryChange,
  onAcknowledgeNoValidationChange,
  onAllowOutOfScopeChange,
  actions,
  onSaveAssignment,
  onEditDraftChange,
  onEditCancel,
  index = 0,
}: TaskCardProps) {
  const staggerDelay = index * 30;
  return (
    <div
      className="rounded-lg border border-line bg-panel-2 p-2.5 text-[11px] animate-stagger-rail"
      style={{ '--dp-delay': `${Math.min(staggerDelay, 350)}ms` } as React.CSSProperties}
      data-testid={`orchestration-task-${task.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <TaskStateBadge state={task.state} />
            <span className="text-xs font-medium text-ink">
              {taskTitle(task.description, 'Untitled agent task')}
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
            <summary className="disclosure-summary">Advanced task details</summary>
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
          className="btn btn-sm shrink-0"
          onClick={onSelect}
          data-testid={`orchestration-task-actions-${task.id}`}
        >
          {selected ? 'Hide actions' : 'Actions'}
        </button>
      </div>

      {task.scopeViolations.length > 0 ? (
        <div className="mt-1.5">
          <Notice tone="warn">
            Changes outside the declared scope. Review Advanced task details for affected paths.
          </Notice>
        </div>
      ) : null}
      {task.validationSummary ? (
        <p className="mt-1.5 text-muted">
          Validation ({task.validationStatus}): {briefText(task.validationSummary)}
        </p>
      ) : null}
      {task.integrationReason ? (
        <div className="mt-1.5">
          <Notice tone="danger">
            Integration ({task.integrationStatus}): {briefText(task.integrationReason)}
          </Notice>
        </div>
      ) : null}

      {selected ? (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-app p-2">
          <label className="text-[11px] text-muted">
            Completion evidence (what the agent finished; required before validation and
            integration)
            <textarea
              className="input mt-1 min-h-16 w-full"
              maxLength={4000}
              value={completionSummary}
              placeholder="For example: implemented the settings API and committed it on the task branch."
              onChange={(event) => onCompletionSummaryChange(event.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={acknowledgeNoValidation}
              onChange={(event) => onAcknowledgeNoValidationChange(event.target.checked)}
            />
            I understand no validation checks are configured for this project
          </label>
          <label className="flex items-center gap-2 text-muted">
            <input
              type="checkbox"
              checked={allowOutOfScope}
              onChange={(event) => onAllowOutOfScopeChange(event.target.checked)}
            />
            I reviewed and approve the unexpected files listed above
          </label>
          <TaskActionButtons
            task={task}
            busyKey={busyKey}
            live={live}
            completionSummary={completionSummary}
            handlers={actions}
            sessionId={sessionId}
            taskDescription={task.description ?? ''}
          />

          <TaskCardEditDraft
            editDraft={editDraft}
            busyKey={busyKey}
            onEditDraftChange={onEditDraftChange}
            onSaveAssignment={onSaveAssignment}
            onEditCancel={onEditCancel}
          />

          <TaskCardLogs logs={logs} />
        </div>
      ) : null}
    </div>
  );
}