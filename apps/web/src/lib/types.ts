import type { ToolProfile } from '../../../../shared/api-types.cjs';

export type {
  AgentTaskIntegrationStatus,
  AgentTaskState,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentTaskValidationStatus,
  OrchestrationCapacity,
  OrchestrationSettings,
  Project,
  ProjectPathStatus,
  SessionMode,
  SessionOrchestrationSummary,
  SessionStatus,
  SessionSummary,
  SessionTerminal,
  TaskIntegrationAttempt,
  TaskValidationResult,
  TerminalDisplayStatus,
  TerminalLayout,
  ToolProfile,
  ToolStatus,
  ValidationCommandConfig,
  WorkflowPlanSummary,
  WorkflowSummary,
  WorkspaceMode,
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
