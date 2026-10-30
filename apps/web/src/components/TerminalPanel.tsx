import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eraser,
  Loader2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCw,
  Square,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import protocol from '../../../../shared/protocol.json';
import { localToken } from '../lib/api';
import type { SessionTerminal, TerminalDisplayStatus } from '../lib/types';
import type { TerminalSplitPlacement } from '../lib/terminalLayout';
import { ConnectionBadge, TerminalStatusBadge } from './Badge';

const { WS_TOKEN_PROTOCOL_PREFIX } = protocol;

interface TerminalPanelProps {
  sessionId: string;
  terminal: SessionTerminal;
  workingDirectory: string;
  version: string | null;
  visible: boolean;
  maximized: boolean;
  active: boolean;
  splitDisabled?: boolean;
  actionsDisabled?: boolean;
  action: 'stop' | 'restart' | null;
  onSplit?: (placement: TerminalSplitPlacement) => void;
  onActivate: () => void;
  onEditTask: () => void;
  onClose: () => void;
  onStop: () => void;
  onRestart: () => void;
  onToggleMaximize: () => void;
  onStatusRefresh: () => void;
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface ExitInfo {
  exitCode: number | null;
  signal: number | null;
  stopRequested: boolean;
}

interface TerminalMessage {
  type?: string;
  data?: unknown;
  status?: unknown;
  pid?: unknown;
  cols?: unknown;
  rows?: unknown;
  reset?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  stopRequested?: unknown;
  message?: unknown;
}

const SPLIT_PLACEMENTS = [
  ['left', ArrowLeft],
  ['right', ArrowRight],
  ['up', ArrowUp],
  ['down', ArrowDown],
] as const;

const SPLIT_LABELS: Record<TerminalSplitPlacement, string> = {
  left: 'Split left',
  right: 'Split right',
  up: 'Split up',
  down: 'Split down',
};

const MENU_WIDTH_PX = 192;
const MENU_ESTIMATED_HEIGHT_PX = 256;
const MENU_OFFSET_PX = 4;
const MENU_VIEWPORT_GUTTER_PX = 8;

interface PanelMenuItemProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
  testId?: string;
}

function PanelMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  tone,
  testId,
}: PanelMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45 ${
        tone === 'danger' ? 'text-danger' : 'text-ink'
      }`}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function socketSend(socket: WebSocket | null, payload: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isLiveTerminal(status: TerminalDisplayStatus): boolean {
  return status === 'starting' || status === 'running';
}

function effectiveStatus(terminal: SessionTerminal, exit: ExitInfo | null): TerminalDisplayStatus {
  if (exit) {
    if (exit.stopRequested) return 'stopped';
    return exit.exitCode === 0 ? 'exited' : 'error';
  }
  return terminal.status;
}

function connectionLabel(state: ConnectionState, live: boolean): string {
  if (state === 'connected') return 'Live';
  if (state === 'connecting') return 'Connecting';
  if (state === 'reconnecting') return 'Reconnecting';
  if (state === 'closed') return 'Disconnected';
  return live ? 'Waiting for connection' : 'No live process';
}

function cssToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function TerminalPanel({
  sessionId,
  terminal,
  workingDirectory,
  version,
  visible,
  maximized,
  active,
  splitDisabled,
  actionsDisabled = false,
  action,
  onSplit,
  onActivate,
  onEditTask,
  onClose,
  onStop,
  onRestart,
  onToggleMaximize,
  onStatusRefresh,
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const exitedRef = useRef(false);
  const refreshRef = useRef(onStatusRefresh);
  const dimensionsRef = useRef({ cols: 0, rows: 0 });

  const [ptyDimensions, setPtyDimensions] = useState({ cols: 0, rows: 0 });
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [exit, setExit] = useState<ExitInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const closeMenu = () => setMenuOpen(false);
    document.addEventListener('pointerdown', closeOnPointerDown);
    document.addEventListener('keydown', closeOnKeyDown);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      document.removeEventListener('keydown', closeOnKeyDown);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menuOpen]);

  const openMenu = () => {
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = rect.bottom + MENU_OFFSET_PX;
    const fitsBelow = below + MENU_ESTIMATED_HEIGHT_PX <= window.innerHeight - MENU_VIEWPORT_GUTTER_PX;
    setMenuPosition({
      top: Math.round(
        fitsBelow
          ? below
          : Math.max(
              MENU_VIEWPORT_GUTTER_PX,
              rect.top - MENU_ESTIMATED_HEIGHT_PX - MENU_OFFSET_PX,
            ),
      ),
      left: Math.round(Math.max(MENU_VIEWPORT_GUTTER_PX, rect.right - MENU_WIDTH_PX)),
    });
    setMenuOpen(true);
  };

  const runMenuAction = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  refreshRef.current = onStatusRefresh;
  const live = isLiveTerminal(terminal.status);
  const status = effectiveStatus(terminal, exit);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: cssToken('--font-mono'),
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      windowOptions: { getWinSizePixels: true },
      theme: {
        background: cssToken('--color-terminal-bg'),
        foreground: cssToken('--color-terminal-fg'),
        cursor: cssToken('--color-terminal-cursor'),
        selectionBackground: cssToken('--color-terminal-selection'),
        black: cssToken('--color-terminal-black'),
        brightBlack: cssToken('--color-terminal-bright-black'),
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    let resizeFrame = 0;
    const fit = () => {
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        if (host.clientWidth === 0 || host.clientHeight === 0) return;
        try {
          fitAddon.fit();
        } catch {
          // The panel can be hidden while the layout changes.
        }
      });
    };

    term.open(host);
    try {
      fitAddon.fit();
    } catch {
      // The panel can be hidden while the layout changes.
    }
    if (term.cols > 0 && term.rows > 0) {
      dimensionsRef.current = { cols: term.cols, rows: term.rows };
    }
    fit();
    terminalRef.current = term;
    fitRef.current = fitAddon;

    const dataDisposable = term.onData((data) => {
      socketSend(socketRef.current, { type: 'input', data });
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      dimensionsRef.current = { cols, rows };
      socketSend(socketRef.current, { type: 'resize', cols, rows });
    });

    const observer = new ResizeObserver(fit);
    observer.observe(host);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(resizeFrame);
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, [terminal.id]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        if (maximized) terminalRef.current?.focus();
      } catch {
        // The panel is still settling into the grid.
      }
    });
  }, [maximized]);

  useEffect(() => {
    exitedRef.current = false;
    setExit(null);
    setNotice(null);
    setPtyDimensions({ cols: 0, rows: 0 });

    if (!live) {
      setConnection('idle');
      return;
    }

    const token = localToken();
    if (!token) {
      setNotice('The local session token is unavailable. Reload the workspace.');
      setConnection('closed');
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let socketAbort: AbortController | null = null;
    let reconnectTimer: number | null = null;
    let attempts = 0;

    const clearReconnect = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || exitedRef.current) return;
      setConnection('reconnecting');
      const delay = Math.min(8000, 500 * 2 ** Math.min(attempts, 4));
      attempts += 1;
      reconnectTimer = window.setTimeout(open, delay);
    };

    const open = () => {
      if (disposed || exitedRef.current) return;
      clearReconnect();
      socketAbort?.abort();
      const abort = new AbortController();
      socketAbort = abort;
      setConnection(attempts === 0 ? 'connecting' : 'reconnecting');

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url =
        `${protocol}//${window.location.host}/ws/sessions/${encodeURIComponent(sessionId)}` +
        `/terminals/${encodeURIComponent(terminal.id)}`;

      try {
        socket = new WebSocket(url, [`${WS_TOKEN_PROTOCOL_PREFIX}${token}`]);
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        attempts = 0;
        setConnection('connected');
        setNotice(null);
        const term = terminalRef.current;
        const currentCols =
          dimensionsRef.current.cols > 0 ? dimensionsRef.current.cols : (term?.cols ?? 0);
        const currentRows =
          dimensionsRef.current.rows > 0 ? dimensionsRef.current.rows : (term?.rows ?? 0);
        if (currentCols > 0 && currentRows > 0) {
          socketSend(socket, { type: 'resize', cols: currentCols, rows: currentRows });
        }
        terminalRef.current?.focus();
      }, { signal: abort.signal });

      socket.addEventListener('message', (event) => {
        let message: TerminalMessage;
        try {
          message = JSON.parse(String(event.data)) as TerminalMessage;
        } catch {
          setNotice('The terminal sent an unreadable message.');
          return;
        }

        if (message.type === 'output' && typeof message.data === 'string') {
          terminalRef.current?.write(message.data);
          return;
        }

        if (message.type === 'replay' && typeof message.data === 'string') {
          if (message.reset === true) terminalRef.current?.reset();
          terminalRef.current?.write(message.data);
          return;
        }

        if (message.type === 'status') {
          if (typeof message.cols === 'number' && typeof message.rows === 'number') {
            setPtyDimensions({ cols: message.cols, rows: message.rows });
          }
          return;
        }

        if (message.type === 'resized') {
          if (typeof message.cols === 'number' && typeof message.rows === 'number') {
            setPtyDimensions({ cols: message.cols, rows: message.rows });
          }
          return;
        }

        if (message.type === 'exit') {
          exitedRef.current = true;
          const info: ExitInfo = {
            exitCode: typeof message.exitCode === 'number' ? message.exitCode : null,
            signal: typeof message.signal === 'number' ? message.signal : null,
            stopRequested: message.stopRequested === true,
          };
          setExit(info);
          setConnection('closed');
          const label = info.stopRequested
            ? 'Terminal stopped.'
            : `Process exited with code ${info.exitCode ?? 'unknown'}.`;
          terminalRef.current?.write(`\r\n\x1b[2m[${label}]\x1b[0m\r\n`);
          refreshRef.current();
          return;
        }

        if (message.type === 'error' && typeof message.message === 'string') {
          setNotice(message.message);
        }
      }, { signal: abort.signal });

      socket.addEventListener('close', () => {
        abort.abort();
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed || exitedRef.current) {
          if (!disposed) setConnection('closed');
          return;
        }
        scheduleReconnect();
      }, { signal: abort.signal });

      socket.addEventListener('error', () => {
        if (!disposed && !exitedRef.current) {
          setNotice('Terminal connection lost. Reconnecting...');
        }
      }, { signal: abort.signal });
    };

    open();

    return () => {
      disposed = true;
      clearReconnect();
      socketAbort?.abort();
      socketAbort = null;
      const current = socketRef.current;
      socketRef.current = null;
      if (current) current.close(1000, 'Terminal panel closed.');
    };
  }, [live, sessionId, terminal.id, terminal.startedAt, terminal.restartCount]);

  const handleClear = () => {
    terminalRef.current?.clear();
  };

  return (
    <article
      className={`terminal-panel panel flex h-full w-full min-h-0 flex-col overflow-hidden ${
        active ? 'terminal-panel-active' : ''
      } ${maximized ? 'terminal-panel-maximized' : ''}`}
      style={{ display: visible || maximized ? undefined : 'none' }}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
      data-testid={`terminal-panel-${terminal.id}`}
      data-pty-size={
        ptyDimensions.cols > 0 ? `${ptyDimensions.cols}x${ptyDimensions.rows}` : undefined
      }
    >
      <header className="terminal-panel-header flex shrink-0 items-center justify-between gap-2 border-b border-line bg-panel px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-ink">{terminal.toolName}</h2>
          <span className="shrink-0" data-testid={`terminal-status-${terminal.id}`}>
            <TerminalStatusBadge status={status} />
          </span>
          <ConnectionBadge
            connected={connection === 'connected'}
            label={connectionLabel(connection, live)}
            testId={`terminal-connection-${terminal.id}`}
          />
          {version ? (
            <span className="shrink-0 text-[11px] text-muted">{version}</span>
          ) : null}
          {terminal.task ? (
            <button
              type="button"
              className="max-w-36 truncate text-left text-[11px] text-muted hover:text-ink"
              onClick={onEditTask}
              title={[
                terminal.task.description || 'Task unassigned',
                `State: ${terminal.task.state}`,
                terminal.task.blockedReason ? `Blocked: ${terminal.task.blockedReason}` : '',
                `Declared scope: ${terminal.task.declaredFileScope.join(', ') || 'none'}`,
                `Dependencies: ${terminal.task.dependencies.join(', ') || 'none'}`,
                `Validation: ${terminal.task.validationStatus}`,
                `Integration: ${terminal.task.integrationStatus}`,
              ]
                .filter(Boolean)
                .join('\n')}
              aria-label={`Edit task for ${terminal.toolName}`}
              data-testid={`edit-task-${terminal.id}`}
            >
              {terminal.task.description || 'Assign task'}
            </button>
          ) : null}
        </div>
        <div ref={menuRef} className="relative flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="btn btn-icon text-muted"
            onClick={onClose}
            disabled={actionsDisabled}
            title="Close terminal panel and stop its process"
            aria-label={`Close ${terminal.toolName} terminal`}
            data-testid={`close-terminal-${terminal.id}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            className="btn btn-icon text-muted"
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="More terminal actions"
            aria-label={`More actions for ${terminal.toolName}`}
            data-testid={`terminal-menu-${terminal.id}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <div
              role="menu"
              className="fixed z-40 rounded-lg border border-line bg-panel p-1 shadow-xl"
              style={{ top: menuPosition.top, left: menuPosition.left, width: MENU_WIDTH_PX }}
            >
              {SPLIT_PLACEMENTS.map(([placement, Icon]) => (
                <PanelMenuItem
                  key={placement}
                  icon={Icon}
                  label={SPLIT_LABELS[placement]}
                  onClick={() => runMenuAction(() => onSplit?.(placement))}
                  disabled={splitDisabled || actionsDisabled}
                  testId={`split-terminal-${placement}-${terminal.id}`}
                />
              ))}
              <div className="my-1 border-t border-line" />
              <PanelMenuItem
                icon={Eraser}
                label="Clear display"
                onClick={() => runMenuAction(handleClear)}
                testId={`clear-terminal-${terminal.id}`}
              />
              <PanelMenuItem
                icon={action === 'restart' ? Loader2 : RotateCw}
                label={action === 'restart' ? 'Restarting…' : 'Restart'}
                onClick={() => runMenuAction(onRestart)}
                disabled={action !== null || actionsDisabled}
                testId={`restart-terminal-${terminal.id}`}
              />
              <PanelMenuItem
                icon={action === 'stop' ? Loader2 : Square}
                label={action === 'stop' ? 'Stopping…' : 'Stop'}
                tone="danger"
                onClick={() => runMenuAction(onStop)}
                disabled={action !== null || actionsDisabled || !live}
                testId={`stop-terminal-${terminal.id}`}
              />
              <PanelMenuItem
                icon={maximized ? Minimize2 : Maximize2}
                label={maximized ? 'Restore panel' : 'Maximize panel'}
                onClick={() => runMenuAction(onToggleMaximize)}
                testId={`maximize-terminal-${terminal.id}`}
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col bg-app">
        <div
          className="mono flex shrink-0 items-center gap-2 px-3 pb-1 pt-2 text-[10px] text-muted"
          onMouseDown={() => {
            onActivate();
            terminalRef.current?.focus();
          }}
        >
          <span className="min-w-0 truncate" title={workingDirectory}>
            {workingDirectory}
          </span>
          {terminal.workspace?.branchName ? (
            <span className="shrink-0 truncate" title={terminal.workspace.branchName}>
              {terminal.workspace.branchName}
            </span>
          ) : null}
        </div>
        <div
          className="relative min-h-0 flex-1"
          onMouseDown={() => {
            onActivate();
            terminalRef.current?.focus();
          }}
        >
          <div
            ref={hostRef}
            className="absolute inset-0 px-3 pb-2"
            data-testid={`terminal-screen-${terminal.id}`}
            aria-label={`${terminal.toolName} terminal`}
          />
        </div>
      </div>

      <footer className="mono flex shrink-0 items-center justify-between gap-2 border-t border-line bg-panel px-2.5 py-1 text-[10px] text-muted">
        <span className="shrink-0">
          {ptyDimensions.cols > 0 ? 'pty ' : null}
          <span data-testid={`terminal-dimensions-${terminal.id}`}>
            {ptyDimensions.cols > 0
              ? `${ptyDimensions.cols}x${ptyDimensions.rows}`
              : '--'}
          </span>
        </span>
        <span className="min-w-0 flex-1 truncate text-center">
          {notice ??
            (terminal.lastError && !live
              ? terminal.lastError
              : live
                ? 'Input is sent to the real CLI process.'
                : 'Start or restart this terminal to reconnect.')}
        </span>
        <span className="shrink-0">{terminal.pid ? `pid ${terminal.pid}` : ''}</span>
      </footer>
    </article>
  );
}
