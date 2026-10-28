import { Database, KeyRound, Palette, Server, ShieldCheck } from 'lucide-react';
import { useOutletContext } from 'react-router-dom';
import type { AppOutletContext } from '../components/AppLayout';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mono break-all text-xs text-ink">{value}</dd>
    </div>
  );
}

export function SettingsPage() {
  const { backend } = useOutletContext<AppOutletContext>();
  const { health } = backend;
  const runtimeLabel = health
    ? `${health.backend.host}:${health.backend.port}`
    : 'Checking backend...';
  const uptime = health ? `${health.backend.uptimeSeconds}s` : 'Unknown';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Server className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink">Runtime</h2>
        </div>
        <dl className="divide-y divide-line px-4 py-2">
          <DetailRow label="App version" value={health?.app.version ?? 'Checking...'} />
          <DetailRow label="Backend address" value={runtimeLabel} />
          <DetailRow label="Last reported uptime" value={uptime} />
          <DetailRow
            label="Terminal support"
            value={health ? health.terminalSupport.detail : 'Checking...'}
          />
          <DetailRow
            label="Database schema"
            value={health ? `v${health.database.schemaVersion}` : 'Checking...'}
          />
        </dl>
      </section>

      <section className="panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <ShieldCheck className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink">Local security</h2>
        </div>
        <ul className="space-y-3 px-4 py-4 text-sm text-muted">
          <li>The backend binds to 127.0.0.1 by default and accepts loopback hosts only.</li>
          <li>API requests require a random local token except the minimal health route.</li>
          <li>There is no endpoint that executes a client-supplied command string.</li>
          <li>CLI profiles are allowlisted records; no secrets are stored in the database.</li>
        </ul>
      </section>

      <section className="panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <KeyRound className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink">How the UI gets the token</h2>
        </div>
        <div className="space-y-3 px-4 py-4 text-sm text-muted">
          <p>
            In development, Vite proxies <span className="mono text-xs text-ink">/api</span> and
            injects the token from the server runtime file (
            <span className="mono text-xs text-ink">server.json</span> in{' '}
            <span className="mono text-xs text-ink">DEVPILOT_RUNTIME_DIR</span>, or{' '}
            <span className="mono text-xs text-ink">.devpilot</span> by default). The browser never
            reads that file.
          </p>
          <p>
            In a packaged build, the backend injects a{' '}
            <span className="mono text-xs text-ink">devpilot-token</span> meta tag into the served
            HTML. The token is regenerated on every backend startup.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <Palette className="h-4 w-4 text-muted" />
          <h2 className="text-sm font-semibold text-ink">Appearance</h2>
        </div>
        <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
          <Database className="h-4 w-4" />
          Dark developer theme with fixed design tokens. Theme editing is not implemented in Phase
          1.
        </div>
      </section>
    </div>
  );
}
