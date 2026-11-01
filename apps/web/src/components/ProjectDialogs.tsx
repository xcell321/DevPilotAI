import { AlertTriangle, FolderOpen, Loader2, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import limits from '../../../../shared/limits.json';
import { apiDelete, apiPatch, apiPost } from '../lib/api';
import type { Project } from '../lib/types';

const { MAX_PROJECT_NAME_LENGTH } = limits;

interface ModalShellProps {
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  testId: string;
}

function ModalShell({
  title,
  description,
  onClose,
  children,
  footer,
  testId,
}: ModalShellProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${testId}-title`}
        data-testid={testId}
        className="panel flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={`${testId}-title`} className="text-base font-semibold text-ink">
              {title}
            </h2>
            <p className="mt-1 text-xs text-muted">{description}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-ink"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">
          {footer}
        </div>
      </div>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-sm text-ink"
    >
      {message}
    </div>
  );
}

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

export function AddProjectDialog({ open, onClose, onCreated }: AddProjectDialogProps) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath('');
    setName('');
    setError(null);
    setBrowsing(false);
    setSubmitting(false);
  }, [open]);

  if (!open) return null;

  const browse = async () => {
    setBrowsing(true);
    setError(null);
    try {
      const result = await apiPost<{ path: string }>('/api/system/pick-folder');
      setPath(result.path);
    } catch (pickerError) {
      setError(
        pickerError instanceof Error
          ? pickerError.message
          : 'Could not open the Windows folder dialog. Enter the path manually.',
      );
    } finally {
      setBrowsing(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim()) {
      setError('Enter a folder path.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const body: { path: string; name?: string } = { path: path.trim() };
      if (name.trim()) body.name = name.trim();
      const result = await apiPost<{ project: Project }>('/api/projects', body);
      onCreated(result.project);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not add the project.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      title="Add project"
      description="Register an existing local folder. DevPilot does not read or modify its files."
      onClose={onClose}
      testId="add-project-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="submit"
            form="add-project-form"
            className="btn btn-primary"
            disabled={submitting || !path.trim()}
            data-testid="create-project"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add project
          </button>
        </>
      }
    >
      <form id="add-project-form" className="space-y-4" onSubmit={submit}>
        {error ? <ErrorNotice message={error} /> : null}

        <div>
          <label htmlFor="project-path" className="mb-1.5 block text-xs font-medium text-muted">
            Folder path
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="project-path"
              className="input mono"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="C:\Projects\My App"
              autoFocus
              spellCheck={false}
              data-testid="project-path"
            />
            <button
              type="button"
              className="btn shrink-0"
              onClick={() => void browse()}
              disabled={browsing || submitting}
              data-testid="browse-folder"
            >
              {browsing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderOpen className="h-4 w-4" />
              )}
              Browse...
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            Manual entry always works. The Windows dialog is optional and returns only the selected
            path.
          </p>
        </div>

        <div>
          <label
            htmlFor="project-name-input"
            className="mb-1.5 block text-xs font-medium text-muted"
          >
            Display name (optional)
          </label>
          <input
            id="project-name-input"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Defaults to the folder name"
            maxLength={MAX_PROJECT_NAME_LENGTH}
            data-testid="project-name-input"
          />
        </div>
      </form>
    </ModalShell>
  );
}

interface EditProjectDialogProps {
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
}

export function EditProjectDialog({ project, onClose, onSaved }: EditProjectDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setError(null);
    setSaving(false);
  }, [project]);

  if (!project) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const result = await apiPatch<{ project: Project }>(`/api/projects/${project.id}`, {
        name: name.trim(),
      });
      onSaved(result.project);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not rename the project.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title="Rename project"
      description="Only the DevPilot display name changes. The folder path is immutable."
      onClose={onClose}
      testId="edit-project-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="submit"
            form="edit-project-form"
            className="btn btn-primary"
            disabled={saving || !name.trim()}
            data-testid="save-project-name"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save name
          </button>
        </>
      }
    >
      <form id="edit-project-form" className="space-y-4" onSubmit={submit}>
        {error ? <ErrorNotice message={error} /> : null}
        <div>
          <label
            htmlFor="edit-project-name"
            className="mb-1.5 block text-xs font-medium text-muted"
          >
            Display name
          </label>
          <input
            id="edit-project-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={MAX_PROJECT_NAME_LENGTH}
            autoFocus
            data-testid="edit-project-name"
          />
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Folder path</p>
          <p className="mono mt-1 break-all rounded-lg border border-line bg-app px-3 py-2 text-xs text-muted">
            {project.path}
          </p>
        </div>
      </form>
    </ModalShell>
  );
}

interface DeleteProjectDialogProps {
  project: Project | null;
  onClose: () => void;
  onRemoved: () => void;
}

export function DeleteProjectDialog({ project, onClose, onRemoved }: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setDeleting(false);
    setError(null);
  }, [project]);

  if (!project) return null;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await apiDelete(`/api/projects/${project.id}`);
      onRemoved();
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : 'Could not remove the project.',
      );
      setDeleting(false);
    }
  };

  return (
    <ModalShell
      title="Remove project"
      description="The folder itself is never deleted or modified."
      onClose={onClose}
      testId="delete-project-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn border-danger bg-danger text-white hover:border-danger hover:bg-danger"
            onClick={() => void remove()}
            disabled={deleting}
            data-testid="confirm-delete-project"
          >
            {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Remove from DevPilot
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex items-start gap-3 rounded-lg border border-line bg-warn-soft px-3 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div className="text-sm text-ink">
            <p className="font-medium">{project.name}</p>
            <p className="mt-1 text-muted">
              Removes from DevPilot only; files are untouched. Projects with saved sessions cannot
              be removed until those session records are gone.
            </p>
            <p className="mono mt-2 break-all text-[11px] text-muted">{project.path}</p>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
