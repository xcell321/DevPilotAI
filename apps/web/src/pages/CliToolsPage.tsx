import { Loader2, RefreshCw, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';
import { EnabledBadge, LaunchBadge, ToolStatusBadge } from '../components/Badge';
import { apiPatch, apiPost } from '../lib/api';
import type { ToolCheckResponse } from '../lib/types';

export function CliToolsPage() {
  const { backend } = useOutletContext<AppOutletContext>();
  const { overview, overviewError, refresh } = backend;
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const checkTool = async (id: string) => {
    setCheckingId(id);
    setCheckError(null);
    setCheckMessage(null);
    try {
      const result = await apiPost<ToolCheckResponse>(
        `/api/tools/${encodeURIComponent(id)}/check`,
      );
      const details = result.check.output
        ? ` Output: ${result.check.output}`
        : result.check.message
          ? ` ${result.check.message}`
          : '';
      setCheckMessage(`${result.tool.displayName}: ${result.check.status}.${details}`);
      await refresh();
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Could not check the CLI profile.');
    } finally {
      setCheckingId(null);
    }
  };

  const toggleTool = async (id: string, enable: boolean) => {
    setTogglingId(id);
    setCheckError(null);
    setCheckMessage(null);
    try {
      await apiPatch(`/api/tools/${encodeURIComponent(id)}`, { enabled: enable });
      await refresh();
      setCheckMessage(`${id} is now ${enable ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : 'Could not update CLI status.');
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <section className="panel p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-panel-2 text-muted">
            <Wrench className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-ink">Verified CLI profiles</h2>
            <p className="mt-1 text-sm text-muted">
              Checks use fixed server-side arguments, a neutral working directory, a timeout, and an
              output cap. No interactive agent or TUI is launched from this screen.
            </p>
          </div>
        </div>
      </section>

      {checkMessage ? (
        <div className="flex items-start justify-between gap-3 rounded-panel border border-line bg-panel-2 px-4 py-3 text-sm text-ink">
          <span className="break-all">{checkMessage}</span>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={() => setCheckMessage(null)}
            aria-label="Dismiss check result"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {checkError ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm text-ink"
        >
          <span>{checkError}</span>
          <button
            type="button"
            className="rounded p-1 text-muted hover:bg-hover hover:text-ink"
            onClick={() => setCheckError(null)}
            aria-label="Dismiss check error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {overviewError ? (
        <div className="flex flex-col gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span>Could not load CLI profiles: {overviewError}</span>
          <button type="button" className="btn px-3 py-1.5" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : null}

      {!overview ? (
        <p className="text-sm text-muted">Loading CLI profiles...</p>
      ) : (
        <div className="space-y-3">
          {overview.tools.map((tool) => (
            <article
              key={tool.id}
              className="panel p-4"
              data-testid={`tool-${tool.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-ink">{tool.displayName}</h2>
                <ToolStatusBadge status={tool.lastStatus} />
                <EnabledBadge enabled={tool.enabled} />
                <LaunchBadge
                  launchVerified={tool.launchVerified}
                  launchable={tool.launchable}
                />
                {tool.defaultOnQuickStart ? (
                  <span className="inline-flex items-center rounded-full border border-line bg-primary-soft px-2 py-0.5 text-[11px] font-medium text-ink">
                    Quick Start default
                  </span>
                ) : null}
                <span className="mono text-[11px] text-muted">{tool.id}</span>
              </div>

              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[11px] text-muted">Executable</dt>
                  <dd className="mono mt-0.5 break-all text-xs text-ink">
                    {tool.command || 'Not configured'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted">Detected version</dt>
                  <dd className="mono mt-0.5 break-all text-xs font-medium text-ink">
                    {tool.version ?? (tool.lastStatus === 'missing' ? 'Not installed' : 'Not checked yet')}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted">Fixed arguments</dt>
                  <dd className="mono mt-0.5 break-all text-xs text-ink">
                    {tool.fixedArgs.length ? tool.fixedArgs.join(' ') : 'None'}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] text-muted">Authentication guidance</dt>
                  <dd className="mt-0.5 text-xs text-ink">
                    {tool.authGuidance || 'No authentication guidance provided.'}
                  </dd>
                </div>
              </dl>

              <p className="mt-3 text-xs leading-5 text-muted">
                {tool.notes ?? 'No verification notes recorded.'}
              </p>
              {tool.launchReason ? (
                <p className="mt-1 text-xs font-medium text-warn">{tool.launchReason}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
                <p className="text-[11px] text-muted">
                  {tool.lastCheckedAt
                    ? `Last checked ${new Date(tool.lastCheckedAt).toLocaleString()}`
                    : 'Not checked in this workspace yet'}
                </p>
                <div className="flex items-center gap-2">
                  {tool.enabled ? (
                    <button
                      type="button"
                      className="btn px-2.5 py-1.5 text-danger hover:border-danger"
                      onClick={() => void toggleTool(tool.id, false)}
                      disabled={togglingId !== null || checkingId !== null}
                      data-testid={`toggle-tool-${tool.id}`}
                    >
                      {togglingId === tool.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Disable
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary px-2.5 py-1.5"
                      onClick={() => void toggleTool(tool.id, true)}
                      disabled={togglingId !== null || checkingId !== null || !tool.launchVerified}
                      title={
                        tool.launchVerified
                          ? 'Enable this CLI profile for sessions'
                          : 'Interactive launch must be verified before this profile can be enabled'
                      }
                      data-testid={`toggle-tool-${tool.id}`}
                    >
                      {togglingId === tool.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Enable
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn px-2.5 py-1.5"
                    onClick={() => void checkTool(tool.id)}
                    disabled={checkingId !== null || togglingId !== null}
                    data-testid={`check-tool-${tool.id}`}
                  >
                    {checkingId === tool.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {checkingId === tool.id ? 'Checking...' : 'Check non-interactively'}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
