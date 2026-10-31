import { FileLock2, GitMerge, ListChecks, Loader2, RotateCcw, Square } from 'lucide-react';
import { briefText, taskTitle } from '../lib/format';
import type {
  AgentTaskSummary,
  SessionTerminal,
  TaskIntegrationAttempt,
  TaskValidationResult,
} from '../lib/types';
import { TaskStateBadge } from './Badge';
import { Notice } from './Notice';
import { SendToTerminalButton } from './SendToTerminalButton';
import { CommitPushButton } from './CommitPushButton';

export interface TaskLogs {
  validations: TaskValidationResult[];
  integrations: TaskIntegrationAttempt[];
}

export interface TaskEditDraft {
  taskId: string;
  description: string;
  scope: string;
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
  onComplete: () => void;
  onValidate: () => void;
  onIntegrate: () => void;
  onRetry: () => void;
  onReplan: () => void;
  onStartEdit: () => void;
  onCancelValidation: () => void;
  onCancel: () => void;
  onSaveAssignment: () => void;
  onEditDraftChange: (draft: TaskEditDraft) => void;
  onEditCancel: () => void;
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
  onComplete,
  onValidate,
  onIntegrate,
  onRetry,
  onReplan,
  onStartEdit,
  onCancelValidation,
  onCancel,
  onSaveAssignment,
  onEditDraftChange,
  onEditCancel,
}: TaskCardProps) {
  return (
    <div
      className="rounded-lg border border-line bg-panel-2 p-2.5 text-[11px]"
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
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="btn btn-sm"
              onClick={onComplete}
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
              className="btn btn-sm"
              onClick={onValidate}
              disabled={busyKey !== null || !task.completedAt}
            >
              {busyKey === `validate:${task.id}` ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Re-run validation
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onIntegrate}
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
              className="btn btn-sm"
              onClick={onRetry}
              disabled={busyKey !== null}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Retry
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onReplan}
              disabled={busyKey !== null || live || task.state === 'integrated'}
              title="Narrow this task to writable files no other task owns and keep the rest deferred."
              data-testid={`orchestration-replan-${task.id}`}
            >
              <FileLock2 className="h-3.5 w-3.5" />
              Replan to free files
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onStartEdit}
              disabled={busyKey !== null || live || task.state === 'integrated'}
            >
              <ListChecks className="h-3.5 w-3.5" />
              Edit plan
            </button>
            {task.state === 'validating' ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onCancelValidation}
                disabled={busyKey !== null}
              >
                <Square className="h-3.5 w-3.5" />
                Cancel validation
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm text-danger"
              onClick={onCancel}
              disabled={busyKey !== null || task.state === 'integrated'}
            >
              <Square className="h-3.5 w-3.5" />
              Cancel task
            </button>
            <SendToTerminalButton
              taskId={task.id}
              taskDescription={task.description ?? ''}
            />
            <CommitPushButton
              sessionId={sessionId}
              taskDescription={task.description ?? ''}
            />
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
                    onEditDraftChange({ ...editDraft, description: event.target.value })
                  }
                />
              </label>
              <label className="mt-1 block text-[11px] text-muted">
                Writable scope (one repository-relative file or directory per line)
                <textarea
                  className="input mt-1 min-h-14 w-full font-mono"
                  value={editDraft.scope}
                  onChange={(event) =>
                    onEditDraftChange({ ...editDraft, scope: event.target.value })
                  }
                />
              </label>
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={onSaveAssignment}
                  disabled={busyKey !== null}
                >
                  Save plan
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onEditCancel}
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
                    <summary className="disclosure-summary">
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
}
