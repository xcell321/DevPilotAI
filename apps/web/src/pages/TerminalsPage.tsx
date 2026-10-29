import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  LayoutGrid,
  Loader2,
  Plus,
  RefreshCw,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';
import { AgentTaskDialog } from '../components/AgentTaskDialog';
import { SessionStatusBadge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { TaskOrchestrationPanel } from '../components/TaskOrchestrationPanel';
import { TerminalPanel } from '../components/TerminalPanel';
import { TerminalSplitView } from '../components/TerminalSplitView';
import { WorkflowComposer } from '../components/WorkflowComposer';
import { apiGet, apiPost } from '../lib/api';
import type { SessionSummary, TerminalLayout, ToolProfile, WorkspacePreferences } from '../lib/types';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  loadWorkspacePreferences,
  saveWorkspacePreferences,
  type WorkspacePreferencesPatch,
} from '../lib/workspacePreferences';
import {
  hasSavedTerminalLayout,
  loadTerminalLayout,
  createTerminalLayoutForPreset,
  removeTerminal,
  resizeTerminalSplit,
  saveTerminalLayout,
  splitTerminal,
  terminalIdsInLayout,
  type TerminalSplitPlacement,
  type TerminalWorkspaceLayout,
} from '../lib/terminalLayout';

interface TerminalAction {
  key: string;
  kind: 'stop' | 'restart';
}

function isLive(session: SessionSummary): boolean {
  return session.terminals.some(
    (terminal) => terminal.status === 'running' || terminal.status === 'starting',
  );
}

export function TerminalsPage() {
  const { openNewSession, backend } = useOutletContext<AppOutletContext>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<TerminalAction | null>(null);
  const [taskEditorTerminalId, setTaskEditorTerminalId] = useState<string | null>(null);
  const [sessionStopping, setSessionStopping] = useState(false);
  const [tools, setTools] = useState<ToolProfile[]>([]);
  const [terminalLimit, setTerminalLimit] = useState<number | null>(null);
  const [toolChoice, setToolChoice] = useState('');
  const [addTaskDescription, setAddTaskDescription] = useState('');
  const [addTaskScope, setAddTaskScope] = useState('');
  const [addTaskDependencies, setAddTaskDependencies] = useState<string[]>([]);
  const [workspaceModeChoice, setWorkspaceModeChoice] = useState<'shared' | 'isolated' | ''>('');
  const [layout, setLayout] = useState<TerminalWorkspaceLayout | null>(null);
  const [layoutSessionId, setLayoutSessionId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<WorkspacePreferences>(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const requestRef = useRef(0);
  const openedSessionRef = useRef<string | null>(null);
  const addInFlightRef = useRef(false);
  const addChoiceRef = useRef<HTMLSelectElement>(null);
  const layoutRef = useRef<TerminalWorkspaceLayout | null>(null);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const result = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions');
      if (requestId !== requestRef.current) return;
      setSessions(result.sessions);
      setLoadError(null);
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setLoadError(error instanceof Error ? error.message : 'Could not load sessions.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 1500);
    return () => {
      window.clearInterval(timer);
      requestRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    let ignore = false;
    void loadWorkspacePreferences().then((next) => {
      if (ignore) return;
      setPreferences(next);
      setPreferencesLoaded(true);
    });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    void Promise.all([
      apiGet<{ tools: ToolProfile[] }>('/api/tools'),
      apiGet<{ limits: { maxTerminalsPerSession: number } }>('/api/overview'),
    ])
      .then(([toolResult, overview]) => {
        if (ignore) return;
        setTools(toolResult.tools);
        setTerminalLimit(overview.limits.maxTerminalsPerSession);
      })
      .catch((error: unknown) => {
        if (ignore) return;
        setActionError(
          error instanceof Error ? error.message : 'CLI profiles could not be loaded.',
        );
      });
    return () => {
      ignore = true;
    };
  }, []);

  const selectedId = searchParams.get('session');
  const selected = sessions?.find((session) => session.id === selectedId) ?? null;
  const terminals = selected?.terminals ?? [];
  const terminalIdsKey = terminals.map((terminal) => terminal.id).join('|');

  useEffect(() => {
    if (!sessions || sessions.length === 0 || !preferencesLoaded) return;
    if (selectedId && sessions.some((session) => session.id === selectedId)) return;
    const saved = preferences.selectedSessionId
      ? sessions.find((session) => session.id === preferences.selectedSessionId)
      : undefined;
    const preferred = saved ?? sessions.find(isLive) ?? sessions[0];
    setSearchParams({ session: preferred.id }, { replace: true });
  }, [sessions, selectedId, setSearchParams, preferences, preferencesLoaded]);

  useEffect(() => {
    if (!preferencesLoaded || !selected) return;
    const currentIds = terminals.map((terminal) => terminal.id);
    if (addInFlightRef.current && layoutSessionId === selected.id) return;
    const knownIds = layout
      ? [...terminalIdsInLayout(layout.tree), ...layout.closedTerminalIds]
      : [];
    if (
      layoutSessionId === selected.id &&
      knownIds.length === currentIds.length &&
      currentIds.every((id) => knownIds.includes(id))
    ) {
      return;
    }

    const saved = hasSavedTerminalLayout(selected.id);
    const restored = saved
      ? loadTerminalLayout(selected.id, currentIds)
      : createTerminalLayoutForPreset(
          currentIds,
          preferences.terminalLayout,
          preferences.maximizedTerminalId,
        );
    layoutRef.current = restored;
    setLayout(restored);
    setLayoutSessionId(selected.id);
    saveTerminalLayout(selected.id, restored);
  }, [
    layout,
    layoutSessionId,
    preferences.maximizedTerminalId,
    preferences.terminalLayout,
    preferencesLoaded,
    selected,
    terminalIdsKey,
  ]);

  const applySession = (updated: SessionSummary) => {
    setSessions((current) =>
      current
        ? current.map((session) => (session.id === updated.id ? updated : session))
        : current,
    );
  };

  const openWorkflowSession = (created: SessionSummary) => {
    setSessions((current) =>
      current
        ? [created, ...current.filter((session) => session.id !== created.id)]
        : [created],
    );
    setSearchParams({ session: created.id });
  };

  const updatePreferences = (patch: WorkspacePreferencesPatch) => {
    setPreferences((current) => ({ ...current, ...patch }));
    void saveWorkspacePreferences(patch).catch(() => undefined);
  };

  const commitLayout = (sessionId: string, next: TerminalWorkspaceLayout) => {
    layoutRef.current = next;
    setLayout(next);
    setLayoutSessionId(sessionId);
    saveTerminalLayout(sessionId, next);
  };

  useEffect(() => {
    if (!preferencesLoaded || !selected) return;
    if (preferences.selectedSessionId === selected.id) return;
    updatePreferences({
      selectedSessionId: selected.id,
      selectedProjectId: selected.project.id,
      maximizedTerminalId: null,
    });
  }, [preferencesLoaded, preferences.selectedSessionId, selected]);

  useEffect(() => {
    if (!selected || openedSessionRef.current === selected.id) return;
    openedSessionRef.current = selected.id;
    void apiPost<{ session: SessionSummary }>(`/api/sessions/${selected.id}/open`)
      .then((result) => applySession(result.session))
      .catch(() => undefined);
  }, [selected]);

  const runTerminalAction = async (
    session: SessionSummary,
    terminalId: string,
    kind: 'stop' | 'restart',
  ) => {
    const key = `${kind}:${terminalId}`;
    setAction({ key, kind });
    setActionError(null);
    try {
      const result = await apiPost<{ session: SessionSummary }>(
        `/api/sessions/${session.id}/terminals/${terminalId}/${kind}`,
      );
      applySession(result.session);
      void backend.refresh();
      void load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The terminal action failed.');
    } finally {
      setAction(null);
    }
  };

  const stopSession = async (session: SessionSummary) => {
    const confirmed = window.confirm(
      `Stop every terminal in "${session.title}"? The saved session and its transcript stay in memory only.`,
    );
    if (!confirmed) return;
    setSessionStopping(true);
    setActionError(null);
    try {
      const result = await apiPost<{ session: SessionSummary }>(
        `/api/sessions/${session.id}/stop`,
      );
      applySession(result.session);
      void backend.refresh();
      void load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not stop the session.');
    } finally {
      setSessionStopping(false);
    }
  };

  const selectSession = (id: string) => {
    setToolChoice('');
    setAddTaskDescription('');
    setAddTaskScope('');
    setAddTaskDependencies([]);
    setWorkspaceModeChoice('');
    setTaskEditorTerminalId(null);
    setActionError(null);
    setSearchParams({ session: id });
  };

  const toggleMaximized = (terminalId: string) => {
    if (!selected || !layout) return;
    const nextId = layout.maximizedTerminalId === terminalId ? null : terminalId;
    commitLayout(selected.id, { ...layout, maximizedTerminalId: nextId });
    updatePreferences({ maximizedTerminalId: nextId });
  };

  const applyLayoutPreset = (preset: TerminalLayout) => {
    if (!selected || !layout) return;
    const activeId = layout.activeTerminalId ?? visibleTerminalIds[0] ?? null;
    if (preset === 'single') {
      if (!activeId) return;
      commitLayout(selected.id, { ...layout, maximizedTerminalId: activeId });
      updatePreferences({
        terminalLayout: preset,
        maximizedTerminalId: activeId,
      });
      return;
    }

    const next = createTerminalLayoutForPreset(visibleTerminalIds, preset);
    commitLayout(selected.id, {
      ...next,
      activeTerminalId:
        activeId && visibleTerminalIds.includes(activeId)
          ? activeId
          : next.activeTerminalId,
      closedTerminalIds: layout.closedTerminalIds,
    });
    updatePreferences({
      terminalLayout: preset,
      maximizedTerminalId: null,
    });
  };

  const closeTerminal = async (terminalId: string) => {
    if (!selected || !layout) return;
    const terminal = terminals.find((item) => item.id === terminalId);
    if (!terminal) return;
    if (
      (terminal.status === 'running' || terminal.status === 'starting') &&
      !window.confirm(`Close ${terminal.toolName} and stop its process?`)
    ) {
      return;
    }

    setAction({ key: `stop:${terminalId}`, kind: 'stop' });
    setActionError(null);
    try {
      if (terminal.status === 'running' || terminal.status === 'starting') {
        const result = await apiPost<{ session: SessionSummary }>(
          `/api/sessions/${selected.id}/terminals/${terminalId}/stop`,
        );
        applySession(result.session);
        void backend.refresh();
      }
      const nextTree = removeTerminal(layout.tree, terminalId);
      const nextVisibleIds = terminalIdsInLayout(nextTree);
      const next: TerminalWorkspaceLayout = {
        ...layout,
        tree: nextTree,
        activeTerminalId:
          layout.activeTerminalId === terminalId
            ? nextVisibleIds[0] ?? null
            : layout.activeTerminalId,
        maximizedTerminalId:
          layout.maximizedTerminalId === terminalId
            ? null
            : layout.maximizedTerminalId,
        closedTerminalIds: [...new Set([...layout.closedTerminalIds, terminalId])],
      };
      commitLayout(selected.id, next);
      if (layout.maximizedTerminalId === terminalId) {
        updatePreferences({ maximizedTerminalId: null });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not close the terminal.');
    } finally {
      setAction(null);
    }
  };

  const addTerminal = async (
    placement: TerminalSplitPlacement = 'right',
    targetTerminalId = layout?.activeTerminalId ?? null,
  ) => {
    if (!selected || !layout || !toolChoice || action) return;
    if (toolChoice.startsWith('terminal:')) {
      const [, terminalId] = toolChoice.split(':', 2);
      const existing = terminals.find((terminal) => terminal.id === terminalId);
      if (!existing || visibleTerminalIds.includes(terminalId)) return;
      addInFlightRef.current = true;
      setAction({ key: `restart:${terminalId}`, kind: 'restart' });
      setActionError(null);
      try {
        let updated = selected;
        if (existing.status !== 'running' && existing.status !== 'starting') {
          const result = await apiPost<{ session: SessionSummary }>(
            `/api/sessions/${selected.id}/terminals/${terminalId}/restart`,
          );
          updated = result.session;
          const restarted = updated.terminals.find((terminal) => terminal.id === terminalId);
          if (!restarted || restarted.status === 'error' || restarted.status === 'unavailable') {
            throw new Error(
              restarted?.lastError ?? 'The saved terminal could not be restarted.',
            );
          }
          applySession(updated);
          void backend.refresh();
        }
        const currentLayout = layoutRef.current ?? layout;
        commitLayout(selected.id, {
          ...currentLayout,
          tree: splitTerminal(currentLayout.tree, targetTerminalId, terminalId, placement),
          activeTerminalId: terminalId,
          maximizedTerminalId: null,
          closedTerminalIds: currentLayout.closedTerminalIds.filter((id) => id !== terminalId),
        });
        setToolChoice('');
        updatePreferences({ maximizedTerminalId: null });
        void load();
      } catch (error) {
        setActionError(
          error instanceof Error ? error.message : 'The saved terminal could not be reopened.',
        );
      } finally {
        addInFlightRef.current = false;
        setAction(null);
      }
      return;
    }
    if (!selected.workspaceMode && !workspaceModeChoice) {
      setActionError('Choose Shared Folder or Isolated Worktrees before adding a terminal to this saved session.');
      return;
    }
    const [choiceType, choiceId] = toolChoice.split(':', 2);
    if (!choiceType || !choiceId) return;

    addInFlightRef.current = true;
    setAction({ key: 'add-terminal', kind: 'restart' });
    setActionError(null);
    let updated = selected;
    let operationError: string | null = null;
    try {
      let terminalId: string;
      if (choiceType === 'terminal') {
        throw new Error('The saved terminal is no longer available.');
      } else if (choiceType === 'tool') {
        const result = await apiPost<{ session: SessionSummary }>(
          `/api/sessions/${selected.id}/terminals`,
          {
            toolId: choiceId,
            workspaceMode: selected.workspaceMode ?? workspaceModeChoice,
            task: {
              description: addTaskDescription,
              declaredFileScope: addTaskScope
                .split(/\r?\n/)
                .map((entry) => entry.trim())
                .filter(Boolean),
              dependencies: addTaskDependencies,
            },
          },
        );
        updated = result.session;
        const previousIds = new Set(terminals.map((terminal) => terminal.id));
        const added = updated.terminals.find((terminal) => !previousIds.has(terminal.id));
        if (!added) throw new Error('The backend did not return the new terminal.');
        terminalId = added.id;
        if (added.status === 'error' || added.workspace?.status === 'failed') {
          const currentLayout = layoutRef.current ?? layout;
          commitLayout(selected.id, {
            ...currentLayout,
            closedTerminalIds: [...new Set([...currentLayout.closedTerminalIds, terminalId])],
          });
          applySession(updated);
          throw new Error(
            added.lastError ??
              added.workspace?.error ??
              'The terminal could not be created.',
          );
        }
      } else {
        throw new Error('Select a launchable CLI profile or a saved terminal.');
      }

      const currentLayout = layoutRef.current ?? layout;
      const next: TerminalWorkspaceLayout = {
        ...currentLayout,
        tree: splitTerminal(
          currentLayout.tree,
          targetTerminalId,
          terminalId,
          placement,
        ),
        activeTerminalId: terminalId,
        maximizedTerminalId: null,
        closedTerminalIds: currentLayout.closedTerminalIds.filter((id) => id !== terminalId),
      };
      commitLayout(selected.id, next);
      applySession(updated);
      setToolChoice('');
      setAddTaskDescription('');
      setAddTaskScope('');
      setAddTaskDependencies([]);
      setWorkspaceModeChoice('');
      updatePreferences({ maximizedTerminalId: null });
      void backend.refresh();
      void load();
    } catch (error) {
      operationError =
        error instanceof Error ? error.message : 'Could not add the terminal.';
    } finally {
      if (operationError) setActionError(operationError);
      addInFlightRef.current = false;
      setAction(null);
    }
  };

  const resizeSplit = (path: boolean[], ratio: number) => {
    if (!selected || !layout) return;
    const tree = resizeTerminalSplit(layout.tree, path, ratio);
    if (tree) commitLayout(selected.id, { ...layout, tree });
  };

  const activateTerminal = (terminalId: string) => {
    if (!selected || !layout || layout.activeTerminalId === terminalId) return;
    commitLayout(selected.id, { ...layout, activeTerminalId: terminalId });
  };

  const maximizedId = layoutSessionId === selected?.id ? layout?.maximizedTerminalId ?? null : null;
  const layoutTree = layoutSessionId === selected?.id ? layout?.tree ?? null : null;
  const visibleTerminalIds = terminalIdsInLayout(layoutTree);
  const hiddenTerminals = terminals.filter(
    (terminal) => !visibleTerminalIds.includes(terminal.id),
  );
  const launchableTools = tools.filter((tool) => tool.launchable);
  const canAddNewTerminal =
    terminalLimit !== null && terminals.length < terminalLimit;
  const selectedLive = selected ? isLive(selected) : false;
  const maximized = Boolean(maximizedId && visibleTerminalIds.includes(maximizedId));
  const activeTerminalId =
    layoutSessionId === selected?.id ? layout?.activeTerminalId ?? null : null;
  const taskEditorTerminal = taskEditorTerminalId
    ? terminals.find((terminal) => terminal.id === taskEditorTerminalId) ?? null
    : null;

  useEffect(() => {
    setToolChoice('');
    setAddTaskDescription('');
    setAddTaskScope('');
    setAddTaskDependencies([]);
    setWorkspaceModeChoice('');
  }, [selected?.id]);

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-2">
      <WorkflowComposer
        onWorkflowStarted={openWorkflowSession}
        session={selected}
        compact={selected !== null}
      />
      <section className="panel flex shrink-0 flex-col gap-2 p-2 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-sm text-muted">
            <LayoutGrid className="h-4 w-4 shrink-0" />
            <label htmlFor="terminal-session" className="shrink-0">
              Session history
            </label>
          </div>
          {sessions && sessions.length > 0 ? (
            <select
              id="terminal-session"
              className="input min-w-0 py-1.5 sm:max-w-xs"
              value={selected?.id ?? ''}
              disabled={action !== null || sessionStopping}
              onChange={(event) => selectSession(event.target.value)}
              data-testid="terminal-session-select"
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title} - {session.status}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-sm text-muted">No saved sessions</span>
          )}
          {selected ? (
            <div className="flex min-w-0 items-center gap-2">
              <SessionStatusBadge status={selected.status} />
              <span className="truncate text-xs text-muted">{selected.project.name}</span>
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-nowrap items-center justify-end gap-1.5 overflow-x-auto">
          {selected ? (
            <div className="flex min-w-max flex-nowrap items-center gap-1">
              <select
                className="input w-auto min-w-32 py-1.5"
                aria-label="Terminal layout"
                value={preferences.terminalLayout}
                onChange={(event) =>
                  applyLayoutPreset(event.target.value as TerminalLayout)
                }
                data-testid="terminal-layout-select"
              >
                <option value="auto">Auto (balanced)</option>
                <option value="single">Focus active terminal</option>
                <option value="horizontal">Horizontal split</option>
                <option value="vertical">Vertical split</option>
                <option value="grid">Balanced grid</option>
              </select>
              {!selected.workspaceMode ? (
                <select
                  className="input w-auto py-1.5"
                  aria-label="Choose workspace mode for this saved session"
                  value={workspaceModeChoice}
                  onChange={(event) => setWorkspaceModeChoice(event.target.value as 'shared' | 'isolated' | '')}
                  data-testid="existing-workspace-mode"
                >
                  <option value="">Choose workspace mode...</option>
                  <option value="shared">Shared Folder</option>
                  <option value="isolated">Isolated Worktrees</option>
                </select>
              ) : null}
              <select
                className="input w-auto min-w-36 py-1.5"
                aria-label="Select CLI profile or saved terminal to add"
                value={toolChoice}
                ref={addChoiceRef}
                disabled={action !== null}
                onChange={(event) => {
                  setToolChoice(event.target.value);
                  setAddTaskDescription('');
                  setAddTaskScope('');
                  setAddTaskDependencies([]);
                }}
                data-testid="add-terminal-choice"
              >
                <option value="">+ Add Terminal...</option>
                {hiddenTerminals.length > 0 ? (
                  <optgroup label="Reopen saved terminal">
                    {hiddenTerminals.map((terminal) => (
                      <option key={terminal.id} value={`terminal:${terminal.id}`}>
                        {terminal.toolName} - {terminal.status}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="Launchable CLI profiles">
                  {launchableTools.map((tool) => (
                    <option
                      key={tool.id}
                      value={`tool:${tool.id}`}
                      disabled={!canAddNewTerminal}
                    >
                      {tool.displayName}
                    </option>
                  ))}
                </optgroup>
              </select>
              {([
                ['left', ArrowLeft],
                ['right', ArrowRight],
                ['up', ArrowUp],
                ['down', ArrowDown],
              ] as const).map(([placement, Icon]) => (
                <button
                  key={placement}
                  type="button"
                  className="btn shrink-0 px-2 py-1.5"
                  onClick={() => void addTerminal(placement)}
                  disabled={
                    !toolChoice ||
                    action !== null ||
                    layoutSessionId !== selected.id ||
                    (toolChoice.startsWith('tool:') && !canAddNewTerminal)
                  }
                  title={`Add the selected terminal ${placement} of the active panel`}
                  data-testid={`split-terminal-${placement}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Add {placement}</span>
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="btn shrink-0 px-2 py-1.5"
            onClick={() => void load()}
            aria-label="Refresh terminal workspace"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {selected && selectedLive ? (
            <button
              type="button"
              className="btn shrink-0 px-2 py-1.5 text-danger hover:border-danger"
              onClick={() => void stopSession(selected)}
              disabled={sessionStopping || action !== null}
              data-testid="stop-session-workspace"
            >
              {sessionStopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Stop session
            </button>
          ) : null}
          <button type="button" className="btn btn-primary shrink-0 px-2.5 py-1.5" onClick={openNewSession}>
            <Plus className="h-4 w-4" />
            New session
          </button>
        </div>
      </section>

      {selected && toolChoice.startsWith('tool:') ? (
        <details className="panel shrink-0 p-3" data-testid="add-terminal-task-form">
          <summary className="cursor-pointer text-xs font-medium text-muted">
            Configure the new agent task and file scope (optional)
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <label className="text-[11px] text-muted">
              Task description
              <textarea
                className="input mt-1 min-h-16 w-full resize-y"
                maxLength={4000}
                value={addTaskDescription}
                onChange={(event) => setAddTaskDescription(event.target.value)}
              />
            </label>
            <label className="text-[11px] text-muted">
              Declared files/folders (one repository-relative path per line)
              <textarea
                className="input mt-1 min-h-16 w-full resize-y font-mono"
                value={addTaskScope}
                onChange={(event) => setAddTaskScope(event.target.value)}
              />
            </label>
            <label className="text-[11px] text-muted">
              Depends on (recorded only; does not delay launch)
              <select
                className="input mt-1 min-h-16 w-full"
                multiple
                value={addTaskDependencies}
                onChange={(event) =>
                  setAddTaskDependencies(
                    Array.from(event.currentTarget.selectedOptions, (option) => option.value),
                  )
                }
              >
                {terminals
                  .filter((terminal) => terminal.task)
                  .map((terminal) => (
                    <option key={terminal.id} value={terminal.id}>
                      {terminal.toolName}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </details>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="flex shrink-0 items-start justify-between gap-3 rounded-panel border border-line bg-danger-soft px-3 py-2 text-xs text-ink"
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="rounded p-0.5 text-muted hover:bg-hover hover:text-ink"
            onClick={() => setActionError(null)}
            aria-label="Dismiss terminal error"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {loadError ? (
        <div className="flex shrink-0 flex-col gap-2 rounded-panel border border-line bg-danger-soft px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            Live status could not be refreshed: {loadError}
          </span>
          <button type="button" className="btn px-2.5 py-1" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}

      {sessions === null && loading ? (
        <div className="panel flex flex-1 items-center justify-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading terminal workspace...
        </div>
      ) : null}

      {sessions && sessions.length === 0 ? (
        <EmptyState
          icon={TerminalIcon}
          title="No saved sessions"
          description="Create a session with a verified CLI profile, then return here to work in its real terminal processes."
          action={
            <button type="button" className="btn btn-primary" onClick={openNewSession}>
              <Plus className="h-4 w-4" />
              Create a session
            </button>
          }
        />
      ) : null}

      {selected ? (
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <div
            className={`flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-panel border px-2 py-1.5 text-[11px] ${
              selected.workspaceMode === 'isolated'
                ? 'border-primary bg-primary-soft text-ink'
                : selected.workspaceMode === 'shared'
                  ? 'border-line bg-panel text-ink'
                  : 'border-lineStrong bg-panel-2 text-warn'
            }`}
            data-testid="workspace-status"
          >
            <span>
              Workspace: <strong>{selected.workspaceMode === 'isolated' ? 'Isolated Worktrees' : selected.workspaceMode === 'shared' ? 'Shared Folder' : 'Mode not set'}</strong>
              {' · '}{selected.project.name} — <span className="mono">{selected.project.path}</span>
            </span>
            <span>
              {selected.workspaceMode === 'isolated'
                ? `${terminals.filter((terminal) => terminal.workspace?.status === 'ready').length} ready worktree(s)`
                : selected.workspaceMode === 'shared'
                  ? 'All terminals use this folder; edits are not isolated.'
                  : 'Choose a mode before adding a CLI; existing terminal paths will not change.'}
            </span>
          </div>
          {selected.workspaceMode === 'shared' ? (
            <p className="shrink-0 rounded-lg border border-line bg-warn-soft px-3 py-2 text-[11px] text-warn">
              Shared Folder mode: terminals edit the same physical files, so concurrent agent tasks
              are blocked and file leases are advisory only. Convert the stopped session to isolated
              worktrees in the task orchestration panel below for enforceable coordination.
            </p>
          ) : null}
          <details
            className="shrink-0 rounded-panel border border-line bg-panel px-2 py-1"
            data-testid="task-orchestration-details"
          >
            <summary className="cursor-pointer text-[11px] text-muted">
              Advanced Details · task history, validation, integration, and recovery
            </summary>
            <div className="max-h-[40vh] overflow-y-auto pt-2">
              <TaskOrchestrationPanel
                session={selected}
                onSessionChanged={applySession}
              />
            </div>
          </details>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-muted">
            <span className="flex items-center gap-1.5">
              <TerminalIcon className="h-3.5 w-3.5" />
              {visibleTerminalIds.length} terminal{visibleTerminalIds.length === 1 ? '' : 's'}
              {terminalLimit !== null ? ` / ${terminalLimit}` : ''} in{' '}
              <span className="mono text-ink">{selected.project.path}</span>
            </span>
            <span>{maximized ? 'Panel maximized' : 'Drag dividers to resize panels'}</span>
          </div>

          {terminalLimit !== null && terminals.length >= terminalLimit ? (
            <p className="shrink-0 px-1 text-[11px] text-warn">
              Session terminal limit reached. Closing stops a process but does not free its saved
              terminal slot; reopen saved terminals from the selector.
            </p>
          ) : null}

          <div className="relative min-h-0 flex-1 overflow-auto" data-testid="terminal-layout">
            {layoutTree ? (
              <TerminalSplitView
                node={layoutTree}
                onResize={resizeSplit}
                renderTerminal={(terminalId) => {
                  const terminal = terminals.find((item) => item.id === terminalId);
                  if (!terminal) return null;
                  const terminalAction =
                    action && action.key.endsWith(`:${terminal.id}`) ? action.kind : null;
                  return (
                    <TerminalPanel
                      key={terminal.id}
                      sessionId={selected.id}
                      terminal={terminal}
                      workingDirectory={
                        terminal.workspace?.workingDirectory ?? selected.project.path
                      }
                      visible={!maximizedId || maximizedId === terminal.id}
                      maximized={maximizedId === terminal.id}
                      active={activeTerminalId === terminal.id}
                      splitDisabled={
                        action !== null ||
                        (toolChoice.startsWith('tool:') && !canAddNewTerminal)
                      }
                      actionsDisabled={action !== null}
                      action={terminalAction}
                      onSplit={(placement) => {
                        if (!toolChoice) {
                          activateTerminal(terminal.id);
                          addChoiceRef.current?.focus();
                          return;
                        }
                        void addTerminal(placement, terminal.id);
                      }}
                      onActivate={() => activateTerminal(terminal.id)}
                      onEditTask={() => setTaskEditorTerminalId(terminal.id)}
                      onClose={() => void closeTerminal(terminal.id)}
                      onStop={() => void runTerminalAction(selected, terminal.id, 'stop')}
                      onRestart={() => void runTerminalAction(selected, terminal.id, 'restart')}
                      onToggleMaximize={() => toggleMaximized(terminal.id)}
                      onStatusRefresh={() => void load()}
                    />
                  );
                }}
              />
            ) : (
              <div className="panel flex h-full min-h-0 items-center justify-center p-6 text-center">
                <div>
                  <TerminalIcon className="mx-auto h-8 w-8 text-muted" />
                  <p className="mt-3 text-sm font-medium text-ink">No terminal panel is open</p>
                  <p className="mt-1 text-xs text-muted">
                    Select a saved terminal to reopen it, or add a launchable CLI profile.
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}
      {selected && taskEditorTerminal ? (
        <AgentTaskDialog
          session={selected}
          terminal={taskEditorTerminal}
          onClose={() => setTaskEditorTerminalId(null)}
          onSaved={applySession}
        />
      ) : null}
    </div>
  );
}
