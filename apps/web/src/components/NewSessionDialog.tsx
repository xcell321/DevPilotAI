import { Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPost } from '../lib/api';
import type {
  Project,
  SessionMode,
  SessionSummary,
  ToolProfile,
  WorkspaceMode,
} from '../lib/types';
import {
  loadWorkspacePreferences,
  saveWorkspacePreferences,
} from '../lib/workspacePreferences';
import {
  EnabledBadge,
  LaunchBadge,
  ToolStatusBadge,
} from './Badge';

interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  tools: ToolProfile[];
  maxTerminals: number | null;
  limitsLoading: boolean;
  onCreated: (session: SessionSummary) => void;
}

interface TaskDraftForm {
  description: string;
  scope: string;
  dependencies: string[];
}

function quickCandidate(tools: ToolProfile[]): ToolProfile | null {
  return tools.find((tool) => tool.defaultOnQuickStart && tool.launchable) ?? null;
}

function quickSelection(tools: ToolProfile[]): string[] {
  const candidate = quickCandidate(tools);
  return candidate ? [candidate.id] : [];
}

function quickUnavailableReason(tools: ToolProfile[]): string {
  const defaults = tools.filter((tool) => tool.defaultOnQuickStart);
  if (defaults.length === 0) {
    return 'No CLI profile is marked for Quick Start.';
  }
  return `Quick Start is unavailable. ${defaults
    .map((tool) => `${tool.displayName}: ${tool.launchReason ?? 'not launchable'}`)
    .join(' ')}`;
}

export function NewSessionDialog({
  open,
  onClose,
  tools,
  maxTerminals,
  limitsLoading,
  onCreated,
}: NewSessionDialogProps) {
  const [mode, setMode] = useState<SessionMode>('quick');
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode | ''>('');
  const [selected, setSelected] = useState<string[]>([]);
  const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraftForm>>({});
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const toolsRef = useRef(tools);
  toolsRef.current = tools;

  useEffect(() => {
    if (!open) return;
    setMode('quick');
    setWorkspaceMode('');
    setSelected(quickSelection(toolsRef.current));
    setTaskDrafts({});
    setTitle('');
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    setProjects(null);
    setProjectError(null);
    setProjectId('');
    void Promise.all([
      apiGet<{ projects: Project[] }>('/api/projects'),
      loadWorkspacePreferences(),
    ])
      .then(([result, preferences]) => {
        if (ignore) return;
        setProjects(result.projects);
        const saved = preferences.selectedProjectId
          ? result.projects.find((project) => project.id === preferences.selectedProjectId)
          : undefined;
        setProjectId((saved ?? result.projects[0])?.id ?? '');
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setProjectError(error instanceof Error ? error.message : 'Could not load projects.');
      });
    return () => {
      ignore = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, submitting]);

  if (!open) return null;

  const selectedProject = projects?.find((project) => project.id === projectId) ?? null;
  const quickTools = tools.filter((tool) => tool.defaultOnQuickStart);
  const candidate = quickCandidate(tools);
  const visibleTools = mode === 'quick' ? quickTools : tools;
  const selectedTools = tools.filter((tool) => selected.includes(tool.id));
  const invalidSelection =
    mode === 'custom' &&
    selected.length > 0 &&
    (selectedTools.length !== selected.length || selectedTools.some((tool) => !tool.launchable));
  const overLimitSelection =
    mode === 'custom' && maxTerminals !== null && selected.length > maxTerminals;

  const changeMode = (nextMode: SessionMode) => {
    setMode(nextMode);
    setSelected(nextMode === 'quick' ? quickSelection(tools) : []);
    setSubmitError(null);
  };

  const toggleTool = (tool: ToolProfile) => {
    if (mode !== 'custom' || !tool.launchable || maxTerminals === null) return;
    setSelected((current) => {
      if (current.includes(tool.id)) {
        return current.filter((id) => id !== tool.id);
      }
      if (current.length >= maxTerminals) return current;
      return [...current, tool.id];
    });
  };

  let startBlockedReason: string | null = null;
  if (maxTerminals === null) {
    startBlockedReason = limitsLoading
      ? 'Loading the session terminal limit...'
      : 'The session terminal limit is unavailable. Refresh the page.';
  } else if (projectError) {
    startBlockedReason = 'Projects could not be loaded.';
  } else if (projects === null) {
    startBlockedReason = 'Loading projects...';
  } else if (projects.length === 0) {
    startBlockedReason = 'Register a project before starting a session.';
  } else if (!selectedProject) {
    startBlockedReason = 'Select a project.';
  } else if (!workspaceMode) {
    startBlockedReason = 'Choose Shared Folder or Isolated Worktrees.';
  } else if (selectedProject.pathStatus !== 'ok') {
    startBlockedReason =
      selectedProject.pathStatus === 'missing'
        ? 'The selected project folder is missing.'
        : 'The selected project folder is not accessible.';
  } else if (mode === 'quick' && !candidate) {
    startBlockedReason = quickUnavailableReason(tools);
  } else if (mode === 'custom' && selected.length === 0) {
    startBlockedReason = 'Select at least one launchable CLI profile.';
  } else if (invalidSelection) {
    startBlockedReason = 'A selected CLI profile is no longer launchable. Select it again.';
  } else if (overLimitSelection) {
    startBlockedReason = `Select no more than ${maxTerminals} CLI profiles.`;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (startBlockedReason || !selectedProject) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: {
        projectId: string;
        mode: SessionMode;
        workspaceMode: WorkspaceMode;
        toolIds?: string[];
        tasks?: Array<{
          toolId: string;
          description: string;
          declaredFileScope: string[];
          dependencies: string[];
        }>;
        title?: string;
      } = {
        projectId: selectedProject.id,
        mode,
        workspaceMode: workspaceMode as WorkspaceMode,
      };
      if (mode === 'custom') body.toolIds = selected;
      body.tasks = selectedTools.map((tool) => {
        const draft = taskDrafts[tool.id];
        return {
          toolId: tool.id,
          description: draft?.description ?? '',
          declaredFileScope: (draft?.scope ?? '')
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean),
          dependencies: draft?.dependencies ?? [],
        };
      });
      if (title.trim()) body.title = title.trim();

      const result = await apiPost<{ session: SessionSummary }>('/api/sessions', body);
      await saveWorkspacePreferences({
        selectedProjectId: result.session.project.id,
        selectedSessionId: result.session.id,
        maximizedTerminalId: null,
      }).catch(() => undefined);
      onCreated(result.session);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not start the session.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4"
      onMouseDown={() => {
        if (!submitting) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-session-title"
        data-testid="new-session-dialog"
        className="panel flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="new-session-title" className="text-base font-semibold text-ink">
              New session
            </h2>
            <p className="mt-1 text-xs text-muted">
              DevPilot launches only enabled, launch-verified CLI profiles in the project folder.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
            aria-label="Close new session dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form id="new-session-form" className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {submitError ? (
              <div
                role="alert"
                className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-sm text-ink"
              >
                {submitError}
              </div>
            ) : null}

            <div>
              <label
                htmlFor="session-project"
                className="mb-1.5 block text-xs font-medium text-muted"
              >
                Project
              </label>
              <select
                id="session-project"
                className="input"
                disabled={!projects || projects.length === 0 || Boolean(projectError) || submitting}
                data-testid="project-select"
                value={projectId}
                onChange={(event) => {
                  const next = event.target.value;
                  setProjectId(next);
                  if (next) {
                    void saveWorkspacePreferences({ selectedProjectId: next }).catch(
                      () => undefined,
                    );
                  }
                }}
              >
                {projects === null && !projectError ? (
                  <option value="">Loading projects...</option>
                ) : null}
                {projectError ? <option value="">Could not load projects</option> : null}
                {projects && projects.length === 0 ? (
                  <option value="">No projects registered</option>
                ) : null}
                {projects?.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} — {project.path}
                  </option>
                ))}
              </select>
              {selectedProject && selectedProject.pathStatus !== 'ok' ? (
                <p role="alert" className="mt-1.5 text-[11px] text-danger">
                  The project folder is{' '}
                  {selectedProject.pathStatus === 'missing' ? 'missing' : 'not accessible'}. Launch
                  is blocked until the folder is available.
                </p>
              ) : (
                <p className="mt-1.5 text-[11px] text-muted">
                  The backend revalidates this folder immediately before every launch and restart.
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="session-name"
                className="mb-1.5 block text-xs font-medium text-muted"
              >
                Session name
              </label>
              <input
                id="session-name"
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
                disabled={submitting}
                placeholder={
                  selectedProject
                    ? `Defaults to ${selectedProject.name} with the current date and time`
                    : 'Optional'
                }
                data-testid="session-title"
              />
            </div>

            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted">Launch mode</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <label
                  className={`cursor-pointer rounded-lg border px-3 py-2.5 text-sm ${
                    mode === 'quick'
                      ? 'border-primary bg-primary-soft text-ink'
                      : 'border-line bg-panel-2 text-muted'
                  }`}
                >
                  <input
                    type="radio"
                    name="session-mode"
                    value="quick"
                    checked={mode === 'quick'}
                    onChange={() => changeMode('quick')}
                    disabled={submitting}
                    className="sr-only"
                  />
                  <span className="block font-medium">Quick Start</span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    First launch-ready default profile
                  </span>
                </label>
                <label
                  className={`cursor-pointer rounded-lg border px-3 py-2.5 text-sm ${
                    mode === 'custom'
                      ? 'border-primary bg-primary-soft text-ink'
                      : 'border-line bg-panel-2 text-muted'
                  }`}
                >
                  <input
                    type="radio"
                    name="session-mode"
                    value="custom"
                    checked={mode === 'custom'}
                    onChange={() => changeMode('custom')}
                    disabled={submitting}
                    className="sr-only"
                  />
                  <span className="block font-medium">Custom session</span>
                  <span className="mt-0.5 block text-[11px] text-muted">
                    {maxTerminals === null
                      ? limitsLoading
                        ? 'Loading session limit'
                        : 'Session limit unavailable'
                      : `Select up to ${maxTerminals} profiles`}
                  </span>
                </label>
              </div>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-xs font-medium text-muted">Workspace mode</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  ['shared', 'Shared Folder', 'Every CLI uses the selected project folder. Concurrent edits can conflict or overwrite each other.'],
                  ['isolated', 'Isolated Worktrees', 'Each CLI gets its own Git worktree. Requires a clean, committed Git repository.'],
                ] as const).map(([value, label, description]) => (
                  <label
                    key={value}
                    className={`cursor-pointer rounded-lg border px-3 py-2.5 text-sm ${
                      workspaceMode === value
                        ? 'border-primary bg-primary-soft text-ink'
                        : 'border-line bg-panel-2 text-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="workspace-mode"
                      value={value}
                      checked={workspaceMode === value}
                      onChange={() => setWorkspaceMode(value)}
                      disabled={submitting}
                      className="sr-only"
                      data-testid={`workspace-mode-${value}`}
                    />
                    <span className="block font-medium">{label}</span>
                    <span className="mt-0.5 block text-[11px] text-muted">{description}</span>
                  </label>
                ))}
              </div>
              {workspaceMode === 'shared' ? (
                <p className="mt-2 rounded-lg border border-line bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  Shared-folder agents are not isolated from one another's file changes. They may conflict or overwrite edits.
                </p>
              ) : null}
            </fieldset>

            <fieldset>
              <legend className="mb-2 flex items-center justify-between gap-2 text-xs font-medium text-muted">
                <span>CLI profiles</span>
                {mode === 'custom' && maxTerminals !== null ? (
                  <span className="text-[11px] font-normal">
                    {selected.length} of {maxTerminals} selected
                  </span>
                ) : null}
              </legend>
              {visibleTools.length === 0 ? (
                <div className="rounded-lg border border-dashed border-lineStrong px-4 py-5 text-sm text-muted">
                  {mode === 'quick'
                    ? quickUnavailableReason(tools)
                    : 'No CLI profiles are registered. Check the CLI Tools screen.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {visibleTools.map((tool) => {
                    const checked =
                      mode === 'quick'
                        ? candidate?.id === tool.id
                        : selected.includes(tool.id);
                    const maxReached =
                      mode === 'custom' &&
                      maxTerminals !== null &&
                      !checked &&
                      selected.length >= maxTerminals;
                    const disabled =
                      submitting ||
                      mode === 'quick' ||
                      !tool.launchable ||
                      maxTerminals === null ||
                      maxReached;
                    return (
                      <label
                        key={tool.id}
                        data-testid={`tool-option-${tool.id}`}
                        className={`flex items-start gap-3 rounded-lg border border-line bg-panel-2 px-3 py-2.5 ${
                          disabled ? 'opacity-70' : 'cursor-pointer'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleTool(tool)}
                          data-testid={`tool-checkbox-${tool.id}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-ink">
                              {tool.displayName}
                            </span>
                            <ToolStatusBadge status={tool.lastStatus} />
                            <EnabledBadge enabled={tool.enabled} />
                            <LaunchBadge
                              launchVerified={tool.launchVerified}
                              launchable={tool.launchable}
                            />
                          </span>
                          <span className="mt-1 block text-[11px] text-muted">
                            {tool.notes ?? 'No verification notes.'}
                          </span>
                          {!tool.launchable && tool.launchReason ? (
                            <span className="mt-1 block text-[11px] text-warn">
                              {tool.launchReason}
                            </span>
                          ) : null}
                          {maxReached ? (
                            <span className="mt-1 block text-[11px] text-warn">
                              Deselect a profile to choose a different one.
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>

            <details className="rounded-lg border border-line bg-panel-2 px-3 py-2">
              <summary className="disclosure-summary">
                Advanced: assign tasks manually
              </summary>
              <fieldset className="mt-3">
                <legend className="mb-2 text-xs font-medium text-muted">
                  Per-agent descriptions, file scopes, and dependencies
                </legend>
                <p className="mb-3 text-[11px] text-muted">
                  This is optional for manually configured sessions. Overlapping declared scopes
                  are rejected by the backend. A dependent task stays queued until its
                  dependencies are integrated.
                </p>
                {selectedTools.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-lineStrong px-3 py-2 text-xs text-muted">
                    Select a CLI profile to configure its task.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {selectedTools.map((tool) => {
                      const draft = taskDrafts[tool.id] ?? {
                        description: '',
                        scope: '',
                        dependencies: [],
                      };
                      const otherSelectedTools = selectedTools.filter(
                        (candidateTool) => candidateTool.id !== tool.id,
                      );
                      return (
                        <div
                          key={tool.id}
                          className="space-y-2 rounded-lg border border-line bg-panel p-3"
                        >
                          <p className="text-xs font-medium text-ink">{tool.displayName}</p>
                          <label className="block text-[11px] text-muted">
                            Task description
                            <textarea
                              className="input mt-1 min-h-16 w-full resize-y"
                              value={draft.description}
                              maxLength={4000}
                              disabled={submitting}
                              placeholder="Describe this agent's independent task"
                              onChange={(event) =>
                                setTaskDrafts((current) => ({
                                  ...current,
                                  [tool.id]: { ...draft, description: event.target.value },
                                }))
                              }
                            />
                          </label>
                          <label className="block text-[11px] text-muted">
                            Declared files or folders (one repository-relative path per line)
                            <textarea
                              className="input mt-1 min-h-14 w-full resize-y font-mono"
                              value={draft.scope}
                              disabled={submitting}
                              placeholder={'apps/web/src\nshared/api-types.d.cts'}
                              onChange={(event) =>
                                setTaskDrafts((current) => ({
                                  ...current,
                                  [tool.id]: { ...draft, scope: event.target.value },
                                }))
                              }
                            />
                          </label>
                          {otherSelectedTools.length > 0 ? (
                            <label className="block text-[11px] text-muted">
                              Depends on (recorded task dependencies)
                              <select
                                className="input mt-1 min-h-16 w-full"
                                multiple
                                value={draft.dependencies}
                                disabled={submitting}
                                onChange={(event) =>
                                  setTaskDrafts((current) => ({
                                    ...current,
                                    [tool.id]: {
                                      ...draft,
                                      dependencies: Array.from(
                                        event.currentTarget.selectedOptions,
                                        (option) => option.value,
                                      ),
                                    },
                                  }))
                                }
                              >
                                {otherSelectedTools.map((dependency) => (
                                  <option key={dependency.id} value={dependency.id}>
                                    {dependency.displayName}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </fieldset>
            </details>
          </div>

          <div className="flex flex-col gap-2 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] text-muted">
              {startBlockedReason ??
                (mode === 'quick' && candidate
                  ? `Quick Start will launch ${candidate.displayName}.`
                  : 'The session will be saved even if a terminal fails to start.')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={Boolean(startBlockedReason) || submitting}
                data-testid="start-session"
                title={startBlockedReason ?? 'Start the selected CLI profiles.'}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {submitting ? 'Starting...' : 'Start session'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
