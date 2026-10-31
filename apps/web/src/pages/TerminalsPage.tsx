import { Loader2, Plus, Terminal as TerminalIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';
import { AgentTaskDialog } from '../components/AgentTaskDialog';
import { EmptyState } from '../components/EmptyState';
import { TaskOrchestrationPanel } from '../components/TaskOrchestrationPanel';
import { TerminalGridHeader } from '../components/TerminalGridHeader';
import { TerminalPanel } from '../components/TerminalPanel';
import { TerminalSessionToolbar } from '../components/TerminalSessionToolbar';
import { TerminalSplitView } from '../components/TerminalSplitView';
import { TerminalStatusLine } from '../components/TerminalStatusLine';
import { WorkflowComposer } from '../components/WorkflowComposer';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { CONVERSION_DETAILS_ANCHOR_ID, LIVE_POLL_INTERVAL_MS } from '../lib/constants';
import { useTerminalLayoutSync } from '../hooks/useTerminalLayoutSync';
import type { SessionSummary, TerminalLayout, ToolProfile, WorkspacePreferences } from '../lib/types';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  loadWorkspacePreferences,
  saveWorkspacePreferences,
  type WorkspacePreferencesPatch,
} from '../lib/workspacePreferences';
import {
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
  const [sessionStarting, setSessionStarting] = useState(false);
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
    }, LIVE_POLL_INTERVAL_MS);
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

  useTerminalLayoutSync({
    selected,
    currentIds: terminals.map((terminal) => terminal.id),
    terminalIdsKey,
    layout,
    layoutSessionId,
    layoutRef,
    addInFlightRef,
    preferences,
    preferencesLoaded,
    setLayout,
    setLayoutSessionId,
  });

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

  const startAllTerminals = async (session: SessionSummary) => {
    setSessionStarting(true);
    setActionError(null);
    try {
      const result = await apiPost<{ started: number; skipped: number; failed: Array<{ terminalId: string; error: string }> }>(
        `/api/sessions/${session.id}/start`,
      );
      if (result.failed.length > 0) {
        setActionError(`${result.started} started, ${result.failed.length} failed.`);
      }
      void backend.refresh();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not start terminals.');
    } finally {
      setSessionStarting(false);
    }
  };

  const [deletingSession, setDeletingSession] = useState(false);
  const [showAdvancedPanel, setShowAdvancedPanel] = useState(true);

  const deleteSession = async (session: SessionSummary) => {
    const confirmed = window.confirm(
      `Permanently delete "${session.title}"? This removes the session, its terminals, tasks, and worktrees. This cannot be undone.`,
    );
    if (!confirmed) return;
    setDeletingSession(true);
    setActionError(null);
    try {
      await apiDelete(`/api/sessions/${session.id}`);
      void backend.refresh();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not delete the session.');
    } finally {
      setDeletingSession(false);
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

  const openConversionDetails = () => {
    document
      .getElementById(CONVERSION_DETAILS_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const layoutReady = Boolean(selected && layout && layoutSessionId === selected.id);
  const readyWorktrees = terminals.filter(
    (terminal) => terminal.workspace?.status === 'ready',
  ).length;

  useEffect(() => {
    setToolChoice('');
    setAddTaskDescription('');
    setAddTaskScope('');
    setAddTaskDependencies([]);
    setWorkspaceModeChoice('');
  }, [selected?.id]);

  return (
    <div className="flex h-full min-h-[600px] gap-4">
      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
      <h2 className="font-serif text-2xl leading-tight text-ink">Terminals</h2>

      {/* Workflow section - boxed */}
      <div className="panel shrink-0">
        <WorkflowComposer
          onWorkflowStarted={openWorkflowSession}
          session={selected}
          compact={selected !== null}
        />
      </div>

      {/* Session section - boxed */}
      <div className="panel shrink-0">
        <span className="eyebrow text-muted block px-2.5 pt-2">Session</span>
        <TerminalSessionToolbar
        sessions={sessions}
        selected={selected}
        selectedLive={selectedLive}
        controlsDisabled={action !== null}
        addDisabled={action !== null || !layoutReady}
        onSelectSession={selectSession}
        hiddenTerminals={hiddenTerminals}
        launchableTools={launchableTools}
        canAddNewTerminal={canAddNewTerminal}
        toolChoice={toolChoice}
        onToolChoiceChange={(choice) => {
          setToolChoice(choice);
          setAddTaskDescription('');
          setAddTaskScope('');
          setAddTaskDependencies([]);
        }}
        onRefresh={() => void load()}
        refreshing={loading}
        onStopSession={() => {
          if (selected) void stopSession(selected);
        }}
        stopping={sessionStopping}
        onStartAll={() => {
          if (selected) void startAllTerminals(selected);
        }}
        starting={sessionStarting}
        onNewSession={openNewSession}
        showConvert={selected?.workspaceMode === 'shared'}
        onOpenConversion={openConversionDetails}
        onDeleteSession={() => {
          if (selected) void deleteSession(selected);
        }}
        deleting={deletingSession}
      />
      </div>

      <TerminalStatusLine
        loadError={loadError}
        actionError={actionError}
        onRetry={() => void load()}
        onDismissActionError={() => setActionError(null)}
        showWorkspace={selected !== null}
        workspaceMode={selected?.workspaceMode ?? null}
        projectName={selected?.project.name ?? ''}
        projectPath={selected?.project.path ?? ''}
        projectId={selected?.project.id ?? ''}
        readyWorktrees={readyWorktrees}
        modeChoice={workspaceModeChoice}
        onModeChoiceChange={setWorkspaceModeChoice}
        onWorktreesCleaned={() => void load()}
      />

      {selected ? (
        <TerminalGridHeader
          visibleCount={visibleTerminalIds.length}
          terminalLimit={terminalLimit}
          limitReached={terminalLimit !== null && terminals.length >= terminalLimit}
          layoutPreset={preferences.terminalLayout}
          onLayoutPresetChange={applyLayoutPreset}
          maximized={maximized}
        />
      ) : null}

      {selected && toolChoice.startsWith('tool:') ? (
        <details className="shrink-0 border-t border-line pt-2" data-testid="add-terminal-task-form">
          <summary className="disclosure-summary">
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

      {sessions === null && loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted">
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
            <button type="button" className="btn btn-brass" onClick={openNewSession}>
              <Plus className="h-4 w-4" />
              Create a session
            </button>
          }
        />
      ) : null}

      {selected ? (
        <section className="flex min-h-0 flex-1 flex-col gap-2">
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
                      version={
                        tools.find((tool) => tool.id === terminal.toolProfileId)?.version ?? null
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
              <div className="flex h-full min-h-0 items-center justify-center p-6 text-center">
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
      </div>{/* End main content */}

      {/* Advanced side panel */}
      {selected ? (
        <aside
          className={`${showAdvancedPanel ? 'w-72' : 'w-10'} shrink-0 overflow-y-auto rounded-xl border border-line bg-panel p-3 transition-all`}
          data-testid="advanced-side-panel"
        >
          <div className="mb-3 flex items-center justify-between">
            {showAdvancedPanel && (
              <span className="eyebrow text-muted">⚙ Advanced</span>
            )}
            <button
              type="button"
              onClick={() => setShowAdvancedPanel(!showAdvancedPanel)}
              className="btn btn-ghost px-2 py-1 text-xs"
              title={showAdvancedPanel ? 'Hide advanced panel' : 'Show advanced panel'}
            >
              {showAdvancedPanel ? 'Hide ›' : '‹'}
            </button>
          </div>
          {showAdvancedPanel && (
            <TaskOrchestrationPanel session={selected} onSessionChanged={applySession} />
          )}
        </aside>
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
