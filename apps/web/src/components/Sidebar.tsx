import { Plus } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import type { BackendState } from '../hooks/useBackend';
import { NAV_ITEMS } from '../lib/navigation';

interface SidebarProps {
  backend: BackendState;
  onNewSession: () => void;
}

export function Sidebar({ backend, onNewSession }: SidebarProps) {
  return (
    <aside className="flex w-16 shrink-0 flex-col border-r border-line bg-panel lg:w-60">
      <div className="flex h-14 items-center gap-3 border-b border-line px-3 lg:px-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-app">
          DP
        </div>
        <div className="hidden min-w-0 lg:block">
          <p className="truncate font-serif text-base leading-tight text-ink">DevPilot AI</p>
        </div>
      </div>

      <div className="p-2 lg:p-3">
        <button
          type="button"
          onClick={onNewSession}
          className="btn btn-primary w-full px-2 lg:px-3"
          title="New session"
          data-testid="new-session-button"
        >
          <Plus className="h-4 w-4" />
          <span className="hidden lg:inline">New session</span>
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2 lg:p-3" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary-soft text-ink'
                    : 'text-muted hover:bg-hover hover:text-ink'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="hidden lg:inline">{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-line p-3">
        {backend.health ? (
          <p className="hidden text-[11px] text-muted lg:block">v{backend.health.app.version}</p>
        ) : null}
      </div>
    </aside>
  );
}
