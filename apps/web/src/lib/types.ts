export type ToolStatus = 'available' | 'missing' | 'unknown' | 'unverified';
export type ToolCheckStatus = 'available' | 'missing' | 'unknown' | 'unconfigured';
export type ProjectPathStatus = 'ok' | 'missing' | 'inaccessible';

export interface ToolProfile {
  id: string;
  displayName: string;
  command: string;
  fixedArgs: string[];
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  launchable: boolean;
  launchReason: string | null;
  lastStatus: ToolStatus;
  lastCheckedAt: string | null;
  notes: string | null;
}

export type SessionMode = 'quick' | 'custom';
export type SessionStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'exited'
  | 'stopped'
  | 'error'
  | 'unavailable';
export type TerminalDisplayStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'stopped'
  | 'error'
  | 'unavailable';

export interface SessionTerminal {
  id: string;
  toolProfileId: string;
  toolName: string;
  status: TerminalDisplayStatus;
  pid: number | null;
  exitCode: number | null;
  errorCode: string | null;
  lastError: string | null;
  startedAt: string | null;
  endedAt: string | null;
  restartCount: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: SessionMode;
  status: SessionStatus;
  project: {
    id: string;
    name: string;
    path: string;
  };
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  terminals: SessionTerminal[];
}

export type TerminalLayout = 'auto' | 'single';

export interface WorkspacePreferences {
  version: 1;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  maximizedTerminalId: string | null;
  terminalLayout: TerminalLayout;
}

export interface Health {
  status: 'ok';
  app: {
    name: string;
    version: string;
  };
  backend: {
    status: 'ok';
    host: string;
    port: number;
    uptimeSeconds: number;
  };
  terminalSupport: {
    status: 'available' | 'unavailable';
    detail: string;
  };
  database: {
    status: 'ok';
    schemaVersion: number;
  };
}

export interface OverviewCounts {
  projects: number;
  sessions: number;
  toolProfiles: number;
  enabledToolProfiles: number;
  runningTerminals: number;
}

export interface OverviewLimits {
  maxTerminalsPerSession: number;
}

export interface Overview {
  counts: OverviewCounts;
  limits: OverviewLimits;
  tools: ToolProfile[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  sessionsCount: number;
  pathStatus: ProjectPathStatus;
}

export interface ToolCheck {
  status: ToolCheckStatus;
  checkedAt: string | null;
  message?: string;
  output?: string;
}

export interface ToolCheckResponse {
  tool: ToolProfile;
  check: ToolCheck;
}
