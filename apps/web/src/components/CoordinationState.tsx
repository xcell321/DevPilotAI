import { FileLock2, ListChecks } from 'lucide-react';
import type { SessionOrchestrationSummary, SessionSummary } from '../lib/types';

interface CoordinationStateProps {
  summary: SessionOrchestrationSummary | null;
  session: SessionSummary;
}

export function CoordinationState({ summary, session }: CoordinationStateProps) {
  return (
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
  );
}
