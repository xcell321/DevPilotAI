import { Loader2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { apiPatch } from '../lib/api';
import { TaskStateBadge } from './Badge';
import type { SessionSummary, SessionTerminal } from '../lib/types';

interface AgentTaskDialogProps {
  session: SessionSummary;
  terminal: SessionTerminal;
  onClose: () => void;
  onSaved: (session: SessionSummary) => void;
}

export function AgentTaskDialog({
  session,
  terminal,
  onClose,
  onSaved,
}: AgentTaskDialogProps) {
  const task = terminal.task;
  const assignmentLocked = terminal.status === 'starting' || terminal.status === 'running';
  const [description, setDescription] = useState(task?.description ?? '');
  const [scope, setScope] = useState(task?.declaredFileScope.join('\n') ?? '');
  const [dependencies, setDependencies] = useState(task?.dependencies ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiPatch<{ session: SessionSummary }>(
        `/api/sessions/${session.id}/terminals/${terminal.id}/task`,
        {
          description,
          declaredFileScope: scope
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean),
          dependencies,
        },
      );
      onSaved(result.session);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The task could not be saved.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      role="presentation"
      onMouseDown={() => {
        if (!submitting) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-task-title"
        className="panel flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden shadow-2xl"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="agent-task-title" className="text-base font-semibold text-ink">
              Agent task — {terminal.toolName}
            </h2>
            <p className="mt-1 text-xs text-muted">
              Scopes are repository-relative. Overlapping scopes are rejected across this session.
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-ink"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close agent task editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {error ? (
            <p role="alert" className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
            {assignmentLocked ? (
              <p className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-xs text-warn">
                Stop this terminal before changing its task description, scope, or dependencies.
                Status updates remain available.
              </p>
            ) : null}
            <label className="block text-xs font-medium text-muted">
            Task description
            <textarea
              className="input mt-1 min-h-20 w-full resize-y"
              maxLength={4000}
              value={description}
              disabled={submitting || assignmentLocked}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-muted">
            Declared files or folders (one path per line)
            <textarea
              className="input mt-1 min-h-24 w-full resize-y font-mono"
              value={scope}
              disabled={submitting || assignmentLocked}
              placeholder={'apps/web/src\nshared/api-types.d.cts'}
              onChange={(event) => setScope(event.target.value)}
            />
          </label>
          <label className="block text-xs font-medium text-muted">
            Depends on
            <select
              className="input mt-1 min-h-20 w-full"
              multiple
              value={dependencies}
              disabled={submitting || assignmentLocked}
              onChange={(event) =>
                setDependencies(
                  Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                )
              }
            >
              {session.terminals
                .filter((candidate) => candidate.id !== terminal.id && candidate.task)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.toolName}
                    {candidate.task?.description ? ` — ${candidate.task.description}` : ''}
                  </option>
                ))}
            </select>
            <span className="mt-1 block font-normal">
              Dependent tasks stay blocked until every dependency is integrated, then the scheduler
              starts them in their own worktree.
            </span>
          </label>
          <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs text-muted">
            <span className="flex flex-wrap items-center gap-2">
              Current state
              {task ? <TaskStateBadge state={task.state} /> : null}
            </span>
            <p className="mt-1">
              States are owned by the backend. Completion, validation, and integration run from the
              task orchestration panel, and a task is never marked completed just because its CLI
              started or exited.
            </p>
            {task?.blockedReason ? <p className="mt-1 text-warn">{task.blockedReason}</p> : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save task
          </button>
        </div>
      </form>
    </div>
  );
}
