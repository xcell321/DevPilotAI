import {
  Folder,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';
import { ProjectPathBadge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import {
  AddProjectDialog,
  DeleteProjectDialog,
  EditProjectDialog,
} from '../components/ProjectDialogs';
import { apiGet } from '../lib/api';
import type { Project } from '../lib/types';

function formatLastUsed(value: string | null): string {
  if (!value) return 'Never used';
  return new Date(value).toLocaleString();
}

export function ProjectsPage() {
  const { backend } = useOutletContext<AppOutletContext>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async (term: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const suffix = term ? `?q=${encodeURIComponent(term)}` : '';
      const result = await apiGet<{ projects: Project[] }>(`/api/projects${suffix}`);
      if (requestId !== requestRef.current) return;
      setProjects(result.projects);
    } catch (loadError) {
      if (requestId !== requestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : 'Could not load projects.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void load(debouncedSearch);
  }, [debouncedSearch, load]);

  const afterChange = async (message: string) => {
    setNotice(message);
    await load(debouncedSearch);
    await backend.refresh();
  };

  const addButton = (
    <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
      <Plus className="h-4 w-4" />
      Add project
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <section className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Folder className="h-4 w-4" />
          <span>
            {projects === null ? 'Loading...' : `${projects.length} registered`}
            {debouncedSearch ? ` for "${debouncedSearch}"` : ''}
          </span>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              className="input py-1.5 pl-8 sm:w-64"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              data-testid="project-search"
            />
          </div>
          <button
            type="button"
            className="btn px-2.5 py-1.5"
            onClick={() => void load(debouncedSearch)}
            aria-label="Refresh projects"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {addButton}
        </div>
      </section>

      {notice ? (
        <div className="flex items-center justify-between gap-3 rounded-panel border border-line bg-ok-soft px-4 py-3 text-sm text-ink">
          <span>{notice}</span>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={() => setNotice(null)}
            aria-label="Dismiss message"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-col gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm text-ink sm:flex-row sm:items-center sm:justify-between">
          <span>Could not load projects: {error}</span>
          <button
            type="button"
            className="btn px-3 py-1.5"
            onClick={() => void load(debouncedSearch)}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : null}

      {projects === null && loading ? (
        <div className="panel flex items-center gap-2 px-4 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading projects...
        </div>
      ) : null}

      {projects && projects.length === 0 ? (
        debouncedSearch ? (
          <div className="panel px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink">No projects match "{debouncedSearch}"</p>
            <p className="mt-1 text-xs text-muted">Try a different name or folder path.</p>
            <button
              type="button"
              className="btn mt-4"
              onClick={() => setSearch('')}
            >
              Clear search
            </button>
          </div>
        ) : (
          <EmptyState
            icon={Folder}
            title="No projects registered"
            description="Add an existing local Windows folder to prepare it for future sessions. DevPilot only stores the path and never reads or modifies the folder."
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setAddOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Add your first project
              </button>
            }
          />
        )
      ) : null}

      {projects && projects.length > 0 ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {projects.map((project) => (
            <article
              key={project.id}
              className="panel flex flex-col p-4"
              data-testid={`project-card-${project.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold text-ink">
                  {project.name}
                </h2>
                <span data-testid="project-path-status">
                  <ProjectPathBadge status={project.pathStatus} />
                </span>
              </div>

              <p className="mono mt-2 break-all text-xs text-muted">{project.path}</p>

              <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs">
                <div>
                  <dt className="text-muted">Sessions</dt>
                  <dd className="mt-0.5 text-ink">
                    {project.sessionsCount} session{project.sessionsCount === 1 ? '' : 's'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Last used</dt>
                  <dd className="mt-0.5 text-ink">{formatLastUsed(project.lastUsedAt)}</dd>
                </div>
              </dl>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="btn px-2.5 py-1.5"
                  onClick={() => setEditing(project)}
                  aria-label={`Rename ${project.name}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Rename
                </button>
                <button
                  type="button"
                  className="btn px-2.5 py-1.5 text-danger hover:border-danger"
                  onClick={() => setDeleting(project)}
                  aria-label={`Remove ${project.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      <AddProjectDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(project) => {
          setAddOpen(false);
          void afterChange(`${project.name} added.`);
        }}
      />
      <EditProjectDialog
        project={editing}
        onClose={() => setEditing(null)}
        onSaved={(project) => {
          setEditing(null);
          void afterChange(`Renamed to ${project.name}.`);
        }}
      />
      <DeleteProjectDialog
        project={deleting}
        onClose={() => setDeleting(null)}
        onRemoved={() => {
          const name = deleting?.name ?? 'Project';
          setDeleting(null);
          void afterChange(`${name} removed from DevPilot. The folder was not changed.`);
        }}
      />
    </div>
  );
}
