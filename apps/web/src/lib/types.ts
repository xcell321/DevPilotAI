import type { ToolProfile } from '../../../../shared/api-types.cjs';

export type {
  Project,
  ProjectPathStatus,
  SessionMode,
  SessionStatus,
  SessionSummary,
  SessionTerminal,
  TerminalDisplayStatus,
  TerminalLayout,
  ToolProfile,
  ToolStatus,
  WorkspacePreferences,
} from '../../../../shared/api-types.cjs';

export type ToolCheckStatus = 'available' | 'missing' | 'unknown' | 'unconfigured';

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
