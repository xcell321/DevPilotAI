import { Loader2, Play, Plus, RefreshCw, SplitSquareHorizontal, Square, Trash2 } from 'lucide-react';
import type { SessionSummary, SessionTerminal, ToolProfile } from '../lib/types';
import { SessionStatusBadge } from './Badge';
import { Tooltip } from './Tooltip';

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
  onStartAll: () => void;
  starting: boolean;
  onNewSession: () => void;
  showConvert: boolean;
  onOpenConversion: () => void;
  onDeleteSession: () => void;
  deleting: boolean;
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
  onStartAll,
  starting,
  onNewSession,
  showConvert,
  onOpenConversion,
  onDeleteSession,
  deleting,
}: TerminalSessionToolbarProps) {
  return (
    <section
      className="flex shrink-0 flex-col gap-2 px-2.5 py-2 xl:flex-row xl:items-center xl:justify-between"
      aria-label="Session and terminal controls"
      data-testid="terminal-session-toolbar"
    >
      <div className="flex min-w-0 items-center gap-2">
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
        </div>
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5">
        {showConvert ? (
          <Tooltip content="Convert to isolated worktrees">
            <button
              type="button"
              className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink"
              onClick={onOpenConversion}
              aria-label="Convert to isolated worktrees"
            >
              <SplitSquareHorizontal className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content="Refresh session">
          <button
            type="button"
            className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink"
            onClick={onRefresh}
            aria-label="Refresh terminal workspace"
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </Tooltip>
        {selected && selectedLive ? (
          <Tooltip content="Stop session">
            <button
              type="button"
              className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover hover:text-danger"
              onClick={onStopSession}
              disabled={stopping || controlsDisabled}
              aria-label="Stop session"
              data-testid="stop-session-workspace"
            >
              {stopping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        ) : selected && !selectedLive ? (
          <Tooltip content="Start all terminals">
            <button
              type="button"
              className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink"
              onClick={onStartAll}
              disabled={starting || controlsDisabled}
              aria-label="Start all terminals"
              data-testid="start-all-terminals"
            >
              {starting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip content="New session">
          <button
            type="button"
            className="btn btn-brass btn-sm"
            onClick={onNewSession}
            aria-label="New session"
          >
            <Plus className="h-4 w-4" />
          </button>
        </Tooltip>
        {selected ? (
          <Tooltip content="Delete session">
            <button
              type="button"
              className="btn btn-icon border-transparent bg-transparent text-muted hover:bg-hover hover:text-danger"
              onClick={onDeleteSession}
              disabled={deleting || controlsDisabled}
              aria-label="Delete session"
              data-testid="delete-session"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        ) : null}
      </div>
    </section>
  );
}
