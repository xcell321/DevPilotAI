import { useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { apiGet } from '../lib/api';

interface TaskDiffButtonProps {
  taskId: string;
}

interface DiffResult {
  diff: string;
  worktreePath: string | null;
  branchName: string | null;
}

export function TaskDiffButton({ taskId }: TaskDiffButtonProps) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDiff = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiGet<DiffResult>(`/api/orchestration/tasks/${taskId}/diff`);
      setDiff(result.diff || '(No changes yet)');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diff');
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    setDiff(null);
    void loadDiff();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        className="rounded border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted hover:border-primary hover:text-ink"
        title="View what this agent has changed"
      >
        View changes
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-line bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <h3 className="font-medium text-ink">Task changes</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadDiff()}
                  disabled={loading}
                  className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
                  title="Refresh diff"
                >
                  <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-ink"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            </div>
            <div className="overflow-auto p-4">
              {loading ? (
                <p className="text-muted">Loading diff...</p>
              ) : error ? (
                <p className="text-danger">{error}</p>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-[11px] text-ink">
                  {diff}
                </pre>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
