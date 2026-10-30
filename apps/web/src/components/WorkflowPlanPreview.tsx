import { Loader2, Play } from 'lucide-react';
import { briefText } from '../lib/format';
import type { WorkflowPlanSummary } from '../lib/types';

interface WorkflowPlanPreviewProps {
  plan: WorkflowPlanSummary;
  projectName: string | null;
  busy: 'preview' | 'start' | 'resume' | null;
  startDisabled: boolean;
  onRegenerate: () => void;
  onStart: () => void;
}

export function WorkflowPlanPreview({
  plan,
  projectName,
  busy,
  startDisabled,
  onRegenerate,
  onStart,
}: WorkflowPlanPreviewProps) {
  return (
    <div className="border-t border-line pt-3 text-xs" data-testid="workflow-plan-review">
      <h3 className="text-xs font-medium text-ink">Review plan</h3>
      <p className="mt-1 text-ink">
        {plan.tasks.length} isolated task{plan.tasks.length === 1 ? '' : 's'} proposed for{' '}
        {projectName ?? 'this project'}.
      </p>
      {plan.conventions.length > 0 ? (
        <p className="mt-1 text-muted">
          Project conventions: {plan.conventions.join(' · ')}
        </p>
      ) : null}
      <ol className="mt-2 flex flex-col gap-1.5">
        {plan.tasks.map((task, index) => (
          <li key={`${task.toolId}-${index}`} className="rounded border border-line bg-panel p-2">
            <p className="font-medium text-ink">{task.agentName}</p>
            <p className="mt-0.5">{briefText(task.description)}</p>
            <details className="mt-1">
              <summary className="disclosure-summary">Task details</summary>
              <p className="mt-1 text-muted">
                Scope: <span className="mono">{task.declaredFileScope.join(', ')}</span>
                {' · '}
                {task.dependencies.length === 0
                  ? 'Can start independently'
                  : `Waits for ${task.dependencies.length} earlier task(s)`}
              </p>
              <p className="mt-1 text-muted">{task.rationale}</p>
            </details>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm"
          onClick={onRegenerate}
          disabled={busy !== null}
          data-testid="regenerate-workflow"
        >
          Regenerate plan
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onStart}
          disabled={busy !== null || startDisabled}
          data-testid="start-workflow"
        >
          {busy === 'start' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Start workflow
        </button>
      </div>
    </div>
  );
}
