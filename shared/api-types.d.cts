export type ToolStatus = 'available' | 'missing' | 'unknown' | 'unverified';

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
  authGuidance?: string | null;
  version?: string | null;
}

export type ProjectPathStatus = 'ok' | 'missing' | 'inaccessible';

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

export interface AgentWorkspaceSummary {
  ownerToolProfileId: string;
  taskTitle: string;
  repositoryRoot: string;
  path: string;
  workingDirectory: string;
  baseCommit: string;
  status: 'provisioning' | 'ready' | 'failed';
  error: string | null;
}

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
  workspace: AgentWorkspaceSummary | null;
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

export type WorkspacePreferencesVersion = 1;

export interface WorkspacePreferences {
  version: WorkspacePreferencesVersion;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  maximizedTerminalId: string | null;
  terminalLayout: TerminalLayout;
}
