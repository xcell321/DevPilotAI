import { Loader2, Plus, RefreshCw, Square } from 'lucide-react';
import type { SessionSummary, SessionTerminal, ToolProfile } from '../lib/types';
import { SessionStatusBadge } from './Badge';

interface TerminalSessionToolbarProps {
  sessions: SessionSummary[] | null;
  selected: SessionSummary | null;
  selectedLive: boolean;
  controlsDisabled: boolean;
  addDisabled: boolean;
  onSelectSession: (sessionId: string) => void;
  hiddenTerminals: SessionTerminal[];
  launchableTools: ToolProfile[];
  canAddNewTerminal: boolean;
  toolChoice: string;
  onToolChoiceChange: (choice: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onStopSession: () => void;
  stopping: boolean;
  onNewSession: () => void;
}

export function TerminalSessionToolbar({
  sessions,
  selected,
  selectedLive,
  controlsDisabled,
  addDisabled,
  onSelectSession,
  hiddenTerminals,
  launchableTools,
  canAddNewTerminal,
  toolChoice,
  onToolChoiceChange,
  onRefresh,
  refreshing,
  onStopSession,
  stopping,
  onNewSession,
}: TerminalSessionToolbarProps) {
  return (
    <section
      className="flex shrink-0 flex-col gap-2 border-b border-line pb-2 xl:flex-row xl:items-center xl:justify-between"
      aria-label="Session and terminal controls"
      data-testid="terminal-session-toolbar"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="eyebrow shrink-0 text-muted">Session</span>
        {sessions && sessions.length > 0 ? (
          <select
            id="terminal-session"
            className="input min-w-0 py-1.5 sm:max-w-xs"
            value={selected?.id ?? ''}
            disabled={controlsDisabled || stopping}
            onChange={(event) => onSelectSession(event.target.value)}
            data-testid="terminal-session-select"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} - {session.status}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-muted">No saved sessions</span>
        )}
        {selected ? <SessionStatusBadge status={selected.status} /> : null}
      </div>

      {selected ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select
            className="input w-auto min-w-36 py-1 text-[11px]"
            aria-label="Select CLI profile or saved terminal to add"
            value={toolChoice}
            disabled={addDisabled}
            onChange={(event) => onToolChoiceChange(event.target.value)}
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
                <option key={tool.id} value={`tool:${tool.id}`} disabled={!canAddNewTerminal}>
                  {tool.displayName}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="text-[11px] text-muted">
            Pick a profile, then use a split arrow in a terminal header.
          </span>
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover"
          onClick={onRefresh}
          aria-label="Refresh terminal workspace"
          disabled={refreshing}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
        {selected && selectedLive ? (
          <button
            type="button"
            className="btn btn-sm border-line bg-transparent text-danger hover:border-danger hover:bg-transparent"
            onClick={onStopSession}
            disabled={stopping || controlsDisabled}
            data-testid="stop-session-workspace"
          >
            {stopping ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop session
          </button>
        ) : null}
        <button type="button" className="btn btn-brass btn-sm" onClick={onNewSession}>
          <Plus className="h-4 w-4" />
          New session
        </button>
      </div>
    </section>
  );
}
