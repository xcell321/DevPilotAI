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
import { EnabledBadge, LaunchBadge } from '../components/Badge';
import { Notice } from '../components/Notice';
import type { AppOutletContext } from '../components/AppLayout';
import { StatTile } from '../components/StatTile';

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
        <Notice
          tone="danger"
          action={{ label: 'Retry', onClick: () => void refresh(), icon: RefreshCw }}
        >
          Could not load overview data: {overviewError}
        </Notice>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <StatTile
              key={stat.label}
              label={stat.label}
              value={stat.value ?? null}
              hint={stat.hint}
              icon={<Icon className="h-4 w-4 text-muted" />}
              testId={stat.testId}
            />
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {counts?.sessions ? (
          <div className="panel flex flex-col justify-between gap-4 p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary via-primary/60 to-transparent" />
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-primary-soft p-2.5 text-primary ring-1 ring-primary/20">
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
              <Link to="/sessions" className="btn btn-sm">
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

        <div className="panel flex flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line bg-panel-2/50 px-5 py-3.5">
            <h2 className="text-[13px] font-semibold tracking-wide text-ink">CLI readiness</h2>
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
                      {tool.launchable
                        ? 'Ready to launch'
                        : tool.launchReason ?? (tool.enabled ? 'Enabled' : 'Not enabled')}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <EnabledBadge enabled={tool.enabled} />
                    <LaunchBadge
                      launchVerified={tool.launchVerified}
                      launchable={tool.launchable}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-muted">Loading CLI profiles...</p>
            )}
          </div>
        </div>
      </section>

      <section className="panel p-5">
        <div className="flex items-center gap-2.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" />
          <h2 className="text-[13px] font-semibold tracking-wide text-ink">Local runtime</h2>
        </div>
        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
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
