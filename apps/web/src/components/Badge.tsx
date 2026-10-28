import type {
  ProjectPathStatus,
  SessionStatus,
  TerminalDisplayStatus,
  ToolStatus,
} from '../lib/types';

const STATUS_LABELS: Record<ToolStatus, string> = {
  available: 'Available',
  missing: 'Missing',
  unknown: 'Unknown',
  unverified: 'Unverified',
};

const STATUS_CLASSES: Record<ToolStatus, string> = {
  available: 'bg-ok-soft text-ok',
  missing: 'bg-danger-soft text-danger',
  unknown: 'bg-warn-soft text-warn',
  unverified: 'bg-hover text-muted',
};

export function ToolStatusBadge({ status }: { status: ToolStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const PATH_STATUS_LABELS: Record<ProjectPathStatus, string> = {
  ok: 'Path OK',
  missing: 'Path missing',
  inaccessible: 'Path inaccessible',
};

const PATH_STATUS_CLASSES: Record<ProjectPathStatus, string> = {
  ok: 'bg-ok-soft text-ok',
  missing: 'bg-danger-soft text-danger',
  inaccessible: 'bg-warn-soft text-warn',
};

export function ProjectPathBadge({ status }: { status: ProjectPathStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${PATH_STATUS_CLASSES[status]}`}
    >
      {PATH_STATUS_LABELS[status]}
    </span>
  );
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${
        enabled ? 'bg-primary-soft text-ink' : 'bg-hover text-muted'
      }`}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

export function LaunchBadge({
  launchVerified,
  launchable,
}: {
  launchVerified: boolean;
  launchable: boolean;
}) {
  const label = launchable
    ? 'Launch ready'
    : launchVerified
      ? 'Launch blocked'
      : 'Launch unverified';
  const classes = launchable
    ? 'bg-ok-soft text-ok'
    : launchVerified
      ? 'bg-warn-soft text-warn'
      : 'bg-hover text-muted';
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {label}
    </span>
  );
}

const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  created: 'Created',
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  stopped: 'Stopped',
  error: 'Error',
  unavailable: 'Unavailable',
};

const SESSION_STATUS_CLASSES: Record<SessionStatus, string> = {
  created: 'bg-hover text-muted',
  starting: 'bg-warn-soft text-warn',
  running: 'bg-ok-soft text-ok',
  exited: 'bg-hover text-muted',
  stopped: 'bg-hover text-muted',
  error: 'bg-danger-soft text-danger',
  unavailable: 'bg-warn-soft text-warn',
};

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${SESSION_STATUS_CLASSES[status]}`}
    >
      {SESSION_STATUS_LABELS[status]}
    </span>
  );
}

const TERMINAL_STATUS_LABELS: Record<TerminalDisplayStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  stopped: 'Stopped',
  error: 'Error',
  unavailable: 'Unavailable',
};

export function TerminalStatusBadge({ status }: { status: TerminalDisplayStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-line px-2 py-0.5 text-[11px] font-medium ${SESSION_STATUS_CLASSES[status]}`}
    >
      {TERMINAL_STATUS_LABELS[status]}
    </span>
  );
}
