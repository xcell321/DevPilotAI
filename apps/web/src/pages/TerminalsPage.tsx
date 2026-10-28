import {
  AlertCircle,
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
import { SessionStatusBadge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { TerminalPanel } from '../components/TerminalPanel';
import { apiGet, apiPost } from '../lib/api';
import type { SessionSummary, WorkspacePreferences } from '../lib/types';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  loadWorkspacePreferences,
  saveWorkspacePreferences,
  type WorkspacePreferencesPatch,
} from '../lib/workspacePreferences';

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
  const [sessionStopping, setSessionStopping] = useState(false);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState<WorkspacePreferences>(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const requestRef = useRef(0);
  const openedSessionRef = useRef<string | null>(null);
  const restoredPreferencesRef = useRef(false);

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

  const selectedId = searchParams.get('session');
  const selected = sessions?.find((session) => session.id === selectedId) ?? null;

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
    if (!preferencesLoaded || restoredPreferencesRef.current) return;
    restoredPreferencesRef.current = true;
    if (preferences.maximizedTerminalId) {
      setMaximizedId(preferences.maximizedTerminalId);
    }
  }, [preferencesLoaded, preferences.maximizedTerminalId]);

  useEffect(() => {
    if (!selected) return;
    if (maximizedId && !selected.terminals.some((terminal) => terminal.id === maximizedId)) {
      setMaximizedId(null);
    }
  }, [selected, maximizedId]);

  const applySession = (updated: SessionSummary) => {
    setSessions((current) =>
      current
        ? current.map((session) => (session.id === updated.id ? updated : session))
        : current,
    );
  };

  const updatePreferences = (patch: WorkspacePreferencesPatch) => {
    setPreferences((current) => ({ ...current, ...patch }));
    void saveWorkspacePreferences(patch).catch(() => undefined);
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
    setMaximizedId(null);
    setActionError(null);
    setSearchParams({ session: id });
  };

  const toggleMaximized = (terminalId: string) => {
    const next = maximizedId === terminalId ? null : terminalId;
    setMaximizedId(next);
    updatePreferences({ maximizedTerminalId: next });
  };

  const terminals = selected?.terminals ?? [];
  const maximized = terminals.some((terminal) => terminal.id === maximizedId);
  const gridRows = terminals.length > 2 ? 'lg:grid-rows-2' : 'lg:grid-rows-1';
  const layoutColumns =
    preferences.terminalLayout === 'single'
      ? 'lg:grid-cols-1'
      : terminals.length === 1
        ? 'lg:grid-cols-1'
        : 'lg:grid-cols-2';
  const selectedLive = selected ? isLive(selected) : false;

  return (
    <div className="flex h-full min-h-[520px] flex-col gap-3">
      <section className="panel flex shrink-0 flex-col gap-3 p-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2 text-sm text-muted">
            <LayoutGrid className="h-4 w-4 shrink-0" />
            <label htmlFor="terminal-session" className="shrink-0">
              Session
            </label>
          </div>
          {sessions && sessions.length > 0 ? (
            <select
              id="terminal-session"
              className="input min-w-0 py-1.5 sm:max-w-xs"
              value={selected?.id ?? ''}
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

        <div className="flex items-center gap-2">
          {selected && terminals.length > 1 ? (
            <label htmlFor="terminal-layout" className="flex items-center gap-1.5 text-xs text-muted">
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Layout</span>
              <select
                id="terminal-layout"
                className="input w-auto py-1.5"
                value={preferences.terminalLayout}
                onChange={(event) =>
                  updatePreferences({
                    terminalLayout: event.target.value as WorkspacePreferences['terminalLayout'],
                  })
                }
                data-testid="terminal-layout-select"
              >
                <option value="auto">Auto grid</option>
                <option value="single">Single column</option>
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="btn px-2.5 py-1.5"
            onClick={() => void load()}
            aria-label="Refresh terminal workspace"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {selected && selectedLive ? (
            <button
              type="button"
              className="btn px-2.5 py-1.5 text-danger hover:border-danger"
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
          <button type="button" className="btn btn-primary" onClick={openNewSession}>
            <Plus className="h-4 w-4" />
            New session
          </button>
        </div>
      </section>

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

      {selected && terminals.length === 0 ? (
        <div className="panel flex flex-1 items-center justify-center px-4 text-sm text-muted">
          This session has no terminal records.
        </div>
      ) : null}

      {selected && terminals.length > 0 ? (
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted">
            <span className="flex items-center gap-1.5">
              <TerminalIcon className="h-3.5 w-3.5" />
              {terminals.length} terminal{terminals.length === 1 ? '' : 's'} in{' '}
              <span className="mono text-ink">{selected.project.path}</span>
            </span>
            <span>
              {maximized ? 'Panel maximized' : 'Resize panels from their lower-right corner'}
            </span>
          </div>

          <div
            className={`grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-2 ${layoutColumns} ${gridRows}`}
          >
            {terminals.map((terminal) => {
              const terminalAction =
                action && action.key.endsWith(`:${terminal.id}`) ? action.kind : null;
              return (
                <TerminalPanel
                  key={terminal.id}
                  sessionId={selected.id}
                  terminal={terminal}
                  visible={maximizedId === null || maximizedId === terminal.id}
                  maximized={maximizedId === terminal.id}
                  action={terminalAction}
                  onStop={() => void runTerminalAction(selected, terminal.id, 'stop')}
                  onRestart={() => void runTerminalAction(selected, terminal.id, 'restart')}
                  onToggleMaximize={() => toggleMaximized(terminal.id)}
                  onStatusRefresh={() => void load()}
                />
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
