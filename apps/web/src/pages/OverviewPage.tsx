import {
  Activity,
  Database,
  Folder,
  MessageSquare,
  Play,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { EnabledBadge } from '../components/Badge';
import type { AppOutletContext } from '../components/AppLayout';

export function OverviewPage() {
  const { backend, openNewSession } = useOutletContext<AppOutletContext>();
  const { overview, health, overviewError, refresh } = backend;
  const counts = overview?.counts;

  const stats = [
    {
      label: 'Projects',
      value: counts?.projects,
      hint: 'Registered local folders',
      icon: Folder,
      testId: 'stat-projects',
    },
    {
      label: 'Sessions',
      value: counts?.sessions,
      hint: 'Saved workspace sessions',
      icon: MessageSquare,
      testId: 'stat-sessions',
    },
    {
      label: 'Enabled CLI profiles',
      value: counts?.enabledToolProfiles,
      hint: 'Allowed to launch',
      icon: Wrench,
      testId: 'stat-tools',
    },
    {
      label: 'Running terminals',
      value: counts?.runningTerminals,
      hint: 'Live child processes',
      icon: Play,
      testId: 'stat-terminals',
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {overviewError ? (
        <div className="flex flex-col gap-3 rounded-panel border border-line bg-danger-soft px-4 py-3 text-sm text-ink sm:flex-row sm:items-center sm:justify-between">
          <span>Could not load overview data: {overviewError}</span>
          <button type="button" className="btn px-3 py-1.5" onClick={() => void refresh()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="panel p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs font-medium text-muted">{stat.label}</p>
                <Icon className="h-4 w-4 text-muted" />
              </div>
              <p
                className="mt-3 text-2xl font-semibold tracking-tight text-ink"
                data-testid={stat.testId}
              >
                {stat.value ?? '—'}
              </p>
              <p className="mt-1 text-[11px] text-muted">{stat.hint}</p>
            </div>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {counts?.sessions ? (
          <div className="panel flex flex-col justify-between gap-4 p-4">
            <div className="flex items-start gap-3">
              <span className="rounded-lg bg-primary-soft p-2 text-primary">
                <MessageSquare className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-ink">Saved sessions</h2>
                <p className="mt-1 text-xs text-muted">
                  {counts.sessions} saved session{counts.sessions === 1 ? '' : 's'} ·{' '}
                  {counts.runningTerminals} running terminal
                  {counts.runningTerminals === 1 ? '' : 's'}.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link to="/sessions" className="btn px-3 py-1.5">
                View sessions
              </Link>
              <button type="button" className="btn btn-primary" onClick={openNewSession}>
                New session
              </button>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={MessageSquare}
            title="No saved sessions yet"
            description="Create a session to launch a verified CLI profile in a registered project folder."
            action={
              <button type="button" className="btn btn-primary" onClick={openNewSession}>
                Create a session
              </button>
            }
          />
        )}

        <div className="panel flex flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">CLI readiness</h2>
            <Link to="/tools" className="text-xs font-medium text-primary hover:underline">
              View all
            </Link>
          </div>
          <div className="divide-y divide-line">
            {overview?.tools.length ? (
              overview.tools.map((tool) => (
                <div key={tool.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{tool.displayName}</p>
                    <p className="truncate text-[11px] text-muted">
                      {tool.enabled ? 'Enabled for sessions' : 'Not enabled'}
                    </p>
                  </div>
                  <EnabledBadge enabled={tool.enabled} />
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-muted">Loading CLI profiles...</p>
            )}
          </div>
        </div>
      </section>

      <section className="panel p-4">
        <h2 className="text-sm font-semibold text-ink">Local runtime</h2>
        <div className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div className="flex items-start gap-2.5">
            <Activity className="mt-0.5 h-4 w-4 text-muted" />
            <div>
              <p className="text-xs text-muted">Terminal support</p>
              <p className="mt-0.5 text-ink">
                {health ? health.terminalSupport.status : 'Checking...'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Database className="mt-0.5 h-4 w-4 text-muted" />
            <div>
              <p className="text-xs text-muted">Database schema</p>
              <p className="mt-0.5 text-ink">
                {health ? `v${health.database.schemaVersion}` : 'Checking...'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-muted" />
            <div>
              <p className="text-xs text-muted">Network exposure</p>
              <p className="mt-0.5 text-ink">Loopback only</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
