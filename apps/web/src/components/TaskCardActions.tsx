import { FileLock2, GitMerge, ListChecks, Loader2, RotateCcw, Square } from 'lucide-react';
import { SendToTerminalButton } from './SendToTerminalButton';
import { CommitPushButton } from './CommitPushButton';

interface TaskActionHandlers {
  onComplete: () => void;
  onValidate: () => void;
  onIntegrate: () => void;
  onRetry: () => void;
  onReplan: () => void;
  onStartEdit: () => void;
  onCancelValidation: () => void;
  onCancel: () => void;
}

interface TaskActionButtonsProps {
  task: {
    id: string;
    state: string;
    completedAt?: string | null;
  };
  busyKey: string | null;
  live: boolean;
  completionSummary: string;
  handlers: TaskActionHandlers;
  sessionId: string;
  taskDescription: string;
}

export function TaskActionButtons({
  task,
  busyKey,
  live,
  completionSummary,
  handlers,
  sessionId,
  taskDescription,
}: TaskActionButtonsProps) {
  const isBusy = (action: string) => busyKey === `${action}:${task.id}`;

  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        className="btn btn-sm"
        onClick={handlers.onComplete}
        disabled={busyKey !== null || !completionSummary.trim() || live}
        title={
          live
            ? 'Stop the agent terminal before recording completion.'
            : 'Record completion evidence and run configured checks.'
        }
      >
        {isBusy('complete') ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : null}
        Record completion & validate
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handlers.onValidate}
        disabled={busyKey !== null || !task.completedAt}
      >
        {isBusy('validate') ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : null}
        Re-run validation
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handlers.onIntegrate}
        disabled={busyKey !== null || !task.completedAt}
        data-testid={`orchestration-integrate-${task.id}`}
      >
        {isBusy('integrate') ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <GitMerge className="h-3.5 w-3.5" />
        )}
        Integrate now
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handlers.onRetry}
        disabled={busyKey !== null}
      >
        <RotateCcw className="h-3.5 w-3.5" />
        Retry
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handlers.onReplan}
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
        onClick={handlers.onStartEdit}
        disabled={busyKey !== null || live || task.state === 'integrated'}
      >
        <ListChecks className="h-3.5 w-3.5" />
        Edit plan
      </button>
      {task.state === 'validating' ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={handlers.onCancelValidation}
          disabled={busyKey !== null}
        >
          <Square className="h-3.5 w-3.5" />
          Cancel validation
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-sm text-danger"
        onClick={handlers.onCancel}
        disabled={busyKey !== null || task.state === 'integrated'}
      >
        <Square className="h-3.5 w-3.5" />
        Cancel task
      </button>
      <SendToTerminalButton
        taskId={task.id}
        taskDescription={taskDescription}
        sessionId={sessionId}
      />
      <CommitPushButton
        sessionId={sessionId}
        taskDescription={taskDescription}
      />
    </div>
  );
}