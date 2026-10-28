import { Folder, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { BackendState } from '../hooks/useBackend';
import { apiGet } from '../lib/api';
import { PAGE_TITLES } from '../lib/navigation';
import type { Project } from '../lib/types';
import { loadWorkspacePreferences } from '../lib/workspacePreferences';

export function TopBar({ backend }: { backend: BackendState }) {
  const location = useLocation();
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const title = PAGE_TITLES[location.pathname] ?? 'Not found';

  useEffect(() => {
    let ignore = false;
    void Promise.all([
      loadWorkspacePreferences(),
      apiGet<{ projects: Project[] }>('/api/projects'),
    ])
      .then(([preferences, result]) => {
        if (ignore) return;
        setSelectedProject(
          result.projects.find((project) => project.id === preferences.selectedProjectId) ?? null,
        );
      })
      .catch(() => {
        if (!ignore) setSelectedProject(null);
      });
    return () => {
      ignore = true;
    };
  }, [location.pathname]);
  const online = Boolean(backend.health);
  const statusLabel = online
    ? 'Backend online'
    : backend.healthError
      ? 'Backend offline'
      : 'Checking backend';
  const running = backend.overview ? String(backend.overview.counts.runningTerminals) : '—';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-panel px-4 lg:px-6">
      <div className="min-w-0">
        <h1 className="truncate text-sm font-semibold text-ink">{title}</h1>
        <p className="truncate text-[11px] text-muted">Local-first developer workspace</p>
      </div>

      <div className="flex items-center gap-3 text-xs text-muted">
        <span
          className="hidden max-w-[220px] items-center gap-1.5 md:flex"
          title={selectedProject ? `Selected project: ${selectedProject.path}` : 'No project selected'}
          data-testid="selected-project"
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedProject?.name ?? 'No project selected'}</span>
        </span>
        <span className="hidden items-center gap-1.5 sm:flex" title="Running terminals">
          <Play className="h-3.5 w-3.5" />
          {running} running
        </span>
        <span
          className="inline-flex items-center gap-2 rounded-full border border-line px-2.5 py-1"
          data-testid="health-status"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              online ? 'bg-ok' : backend.healthError ? 'bg-danger' : 'bg-warn'
            }`}
          />
          {statusLabel}
        </span>
      </div>
    </header>
  );
}
