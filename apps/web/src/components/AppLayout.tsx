import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import type { BackendState } from '../hooks/useBackend';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export interface AppOutletContext {
  backend: BackendState;
  openNewSession: () => void;
}

interface AppLayoutProps {
  backend: BackendState;
  onNewSession: () => void;
}

function RouteFallback() {
  return <div className="panel px-3 py-2 text-sm text-muted">Loading workspace...</div>;
}

export function AppLayout({ backend, onNewSession }: AppLayoutProps) {
  const context: AppOutletContext = { backend, openNewSession: onNewSession };

  return (
    <div className="flex h-full min-h-0 bg-app">
      <Sidebar backend={backend} onNewSession={onNewSession} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar backend={backend} />
        <main className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
          <Suspense fallback={<RouteFallback />}>
            <Outlet context={context} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
