import {
  AlertCircle,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';
import {
  SessionStatusBadge,
  TerminalStatusBadge,
} from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { apiGet, apiPost } from '../lib/api';
import type { SessionSummary, SessionTerminal } from '../lib/types';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function terminalSummary(terminal: SessionTerminal): string {
  if (terminal.status === 'running') return `PID ${terminal.pid ?? 'unknown'} (advisory)`;
  if (terminal.exitCode !== null) return `Exit code ${terminal.exitCode}`;
  return `Restarts: ${terminal.restartCount}`;
}

export function SessionsPage() {
  const { openNewSession, backend } = useOutletContext<AppOutletContext>();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const requestRef = useRef(0);

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
    }, 5000);
    return () => {
      window.clearInterval(timer);
      requestRef.current += 1;
    };
  }, [load]);

  const runAction = async (id: string, pathname: string) => {
    setActionId(id);
    setActionError(null);
    try {
      await apiPost<{ session: SessionSummary }>(pathname);
      await load();
      await backend.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The terminal action failed.');
    } finally {
      setActionId(null);
    }
  };

  const stopSession = async (session: SessionSummary) => {
    const confirmed = window.confirm(
      `Stop every terminal in "${session.title}"? This does not delete the saved session.`,
    );
    if (!confirmed) return;
    await runAction(`session:${session.id}`, `/api/sessions/${session.id}/stop`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <section className="panel flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-muted">
          <MessageSquare className="h-4 w-4" />
          <span>
            {sessions === null ? 'Loading...' : `${sessions.length} saved session${sessions.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn px-2.5 py-1.5"
            onClick={() => void load()}
            aria-label="Refresh sessions"
            disabled={loading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" className="btn btn-primary" onClick={openNewSession}>
            <Plus className="h-4 w-4" />
            New session
          </button>
        </div>
      </section>

      {actionError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm text-ink"
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={() => setActionError(null)}
            aria-label="Dismiss session error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {loadError ? (
        <div className="flex flex-col gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>Could not load sessions: {loadError}</span>
          <button type="button" className="btn px-3 py-1.5" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : null}

      {sessions === null && loading ? (
        <div className="panel flex items-center gap-2 px-4 py-8 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions...
        </div>
      ) : null}

      {sessions && sessions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No saved sessions"
          description="Start a session to launch a verified CLI profile in a registered project folder, then open its terminal workspace."
          action={
            <button type="button" className="btn btn-primary" onClick={openNewSession}>
              <Plus className="h-4 w-4" />
              Create a session
            </button>
          }
        />
      ) : null}

      {sessions && sessions.length > 0 ? (
        <div className="space-y-3">
          {sessions.map((session) => {
            const hasLiveTerminal = session.terminals.some(
              (terminal) =>
                terminal.status === 'running' || terminal.status === 'starting',
            );
            const stopBusy = actionId === `session:${session.id}`;
            return (
              <article
                key={session.id}
                className="panel p-4"
                data-testid={`session-card-${session.id}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0 truncate text-sm font-semibold text-ink">
                        {session.title}
                      </h2>
                      <SessionStatusBadge status={session.status} />
                      <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted">
                        {session.mode === 'quick' ? 'Quick Start' : 'Custom'}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {session.project.name} · <span className="mono">{session.project.path}</span>
                    </p>
                    <p className="mt-1 text-[11px] text-muted">
                      Created {formatDate(session.createdAt)} A� Updated{' '}
                      {formatDate(session.updatedAt)} A� Last opened{' '}
                      {formatDate(session.lastOpenedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Link
                      to={`/terminals?session=${session.id}`}
                      className="btn px-2.5 py-1.5"
                      data-testid={`open-workspace-${session.id}`}
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      Open workspace
                    </Link>
                    {hasLiveTerminal ? (
                      <button
                        type="button"
                        className="btn px-2.5 py-1.5 text-danger hover:border-danger"
                        onClick={() => void stopSession(session)}
                        disabled={actionId !== null}
                        data-testid={`stop-session-${session.id}`}
                      >
                        {stopBusy ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                        Stop session
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {session.terminals.map((terminal) => {
                    const terminalBusy =
                      actionId === `terminal-stop:${terminal.id}` ||
                      actionId === `terminal-restart:${terminal.id}`;
                    const canStop =
                      terminal.status === 'running' || terminal.status === 'starting';
                    return (
                      <div
                        key={terminal.id}
                        className="rounded-lg border border-line bg-panel-2 px-3 py-2.5"
                        data-testid={`session-terminal-${terminal.id}`}
                      >
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-ink">
                                {terminal.toolName}
                              </span>
                              <TerminalStatusBadge status={terminal.status} />
                              <span className="text-[11px] text-muted">
                                {terminalSummary(terminal)}
                              </span>
                            </div>
                            <p className="mt-1 text-[11px] text-muted">
                              Started {formatDate(terminal.startedAt)} · Ended{' '}
                              {formatDate(terminal.endedAt)}
                              {terminal.restartCount > 0
                                ? ` · Restarted ${terminal.restartCount} time${terminal.restartCount === 1 ? '' : 's'}`
                                : ''}
                            </p>
                            {terminal.lastError ? (
                              <p className="mt-1 text-[11px] text-danger">
                                {terminal.lastError}
                                {terminal.errorCode ? (
                                  <span className="mono ml-1 text-muted">
                                    ({terminal.errorCode})
                                  </span>
                                ) : null}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {canStop ? (
                              <button
                                type="button"
                                className="btn px-2.5 py-1.5"
                                onClick={() =>
                                  void runAction(
                                    `terminal-stop:${terminal.id}`,
                                    `/api/terminals/${terminal.id}/stop`,
                                  )
                                }
                                disabled={actionId !== null}
                                data-testid={`stop-terminal-${terminal.id}`}
                              >
                                {actionId === `terminal-stop:${terminal.id}` ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Square className="h-3.5 w-3.5" />
                                )}
                                Stop terminal
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="btn px-2.5 py-1.5"
                              onClick={() =>
                                void runAction(
                                  `terminal-restart:${terminal.id}`,
                                  `/api/terminals/${terminal.id}/restart`,
                                )
                              }
                              disabled={actionId !== null || terminal.status === 'starting'}
                              data-testid={`restart-terminal-${terminal.id}`}
                            >
                              {terminalBusy &&
                              actionId === `terminal-restart:${terminal.id}` ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCw className="h-3.5 w-3.5" />
                              )}
                              Restart
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {session.status === 'error' || session.status === 'unavailable' ? (
                  <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                    <AlertCircle className="h-3.5 w-3.5" />
                    The session record was kept. Use Restart on a terminal to try again.
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
