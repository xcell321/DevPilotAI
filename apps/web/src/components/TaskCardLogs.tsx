import { TaskLogs } from './TaskCard';

interface TaskCardLogsProps {
  logs: TaskLogs | null;
}

export function TaskCardLogs({ logs }: TaskCardLogsProps) {
  if (!logs) return null;

  return (
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
  );
}