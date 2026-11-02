import { TaskEditDraft } from './TaskCard';

interface TaskCardEditDraftProps {
  editDraft: TaskEditDraft | null;
  busyKey: string | null;
  onEditDraftChange: (draft: TaskEditDraft) => void;
  onSaveAssignment: () => void;
  onEditCancel: () => void;
}

export function TaskCardEditDraft({
  editDraft,
  busyKey,
  onEditDraftChange,
  onSaveAssignment,
  onEditCancel,
}: TaskCardEditDraftProps) {
  if (!editDraft) return null;

  return (
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
  );
}