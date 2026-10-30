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
export type WorkspaceMode = 'shared' | 'isolated';

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
  branchName: string | null;
  status: 'provisioning' | 'ready' | 'failed';
  error: string | null;
}

export type AgentTaskStatus =
  | 'unassigned'
  | 'planned'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentTaskState =
  | 'unassigned'
  | 'blocked'
  | 'ready'
  | 'assigned'
  | 'running'
  | 'validating'
  | 'awaiting_integration'
  | 'integrated'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type AgentTaskValidationStatus =
  | 'not_configured'
  | 'pending'
  | 'passed'
  | 'failed';

export type AgentTaskIntegrationStatus =
  | 'not_requested'
  | 'queued'
  | 'integrated'
  | 'conflict'
  | 'failed';

export interface TaskLeaseSummary {
  path: string;
  isDirectory: boolean;
  acquiredAt: string;
  reason: string | null;
}

export interface AgentTaskSummary {
  id: string;
  description: string;
  declaredFileScope: string[];
  dependencies: string[];
  status: AgentTaskStatus;
  state: AgentTaskState;
  blockedReason: string | null;
  changedFiles: string[];
  actualFiles: string[];
  scopeViolations: string[];
  validationStatus: AgentTaskValidationStatus;
  validationSummary: string | null;
  integrationStatus: AgentTaskIntegrationStatus;
  integrationReason: string | null;
  integrationCommit: string | null;
  targetBranch: string | null;
  branchName: string | null;
  worktreePath: string | null;
  completionSummary: string | null;
  completedAt: string | null;
  waitKind: 'dependency' | 'files' | null;
  deferredScope: string[];
  replanCount: number;
  agentToolId: string;
  agentName: string;
  leases: TaskLeaseSummary[];
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
  task: AgentTaskSummary | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: SessionMode;
  workspaceMode: WorkspaceMode | null;
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

export interface ValidationCommandConfig {
  name: string;
  command: string;
  args: string[];
  required: boolean;
  timeoutMs: number;
}

export interface TaskValidationResult {
  id: string;
  taskId: string;
  attempt: number;
  phase: 'task' | 'integration';
  name: string;
  command: string;
  args: string[];
  status: 'running' | 'passed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  durationMs: number | null;
  output: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskIntegrationAttempt {
  id: string;
  taskId: string;
  state: 'queued' | 'running' | 'integrated' | 'rejected' | 'failed';
  targetBranch: string;
  sourceBranch: string;
  sourceCommit: string | null;
  targetCommitBefore: string | null;
  mergeCommit: string | null;
  candidateCommit: string | null;
  validationSummary: string | null;
  changedFiles: string[];
  violations: string[];
  reason: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveLeaseSummary {
  taskId: string;
  taskLabel: string;
  taskState: AgentTaskState;
  agentToolId: string;
  agentName: string;
  path: string;
  isDirectory: boolean;
  reason: string | null;
  acquiredAt: string;
}

export interface WorkflowTaskPlan {
  toolId: string;
  agentName: string;
  description: string;
  declaredFileScope: string[];
  dependencies: number[];
  rationale: string;
}

export interface WorkflowPlanSummary {
  summary: string;
  conventions: string[];
  tasks: WorkflowTaskPlan[];
}

export interface WorkflowSummary {
  id: string;
  projectId: string;
  sessionId: string;
  prompt: string;
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  plan: WorkflowPlanSummary;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationSettings {
  projectId: string;
  autoIntegrate: boolean;
  schedulingPaused: boolean;
  maxConcurrentAgents: number;
  systemMaxConcurrentAgents: number;
  targetBranch: string | null;
  resolvedTargetBranch: string;
  validationCommands: ValidationCommandConfig[];
  protectedPaths: string[];
}

export interface OrchestrationCapacity {
  maxConcurrentAgents: number;
  systemMaxConcurrentAgents: number;
  activeAgents: number;
  maxLiveTerminals: number;
  liveTerminals: number;
  availableSlots: number;
}

export interface SessionOrchestrationSummary {
  sessionId: string;
  workspaceMode: WorkspaceMode | null;
  settings: OrchestrationSettings;
  capacity: OrchestrationCapacity;
  tasks: AgentTaskSummary[];
  sharedFolderRisk: boolean;
  schedulingPaused: boolean;
  workflow: WorkflowSummary | null;
  leases: ActiveLeaseSummary[];
  waiting: Array<{ taskId: string; kind: 'dependency' | 'files'; reason: string }>;
}

export type TerminalLayout = 'auto' | 'single' | 'horizontal' | 'vertical' | 'grid';

export type WorkspacePreferencesVersion = 1;

export interface WorkspacePreferences {
  version: WorkspacePreferencesVersion;
  selectedProjectId: string | null;
  selectedSessionId: string | null;
  maximizedTerminalId: string | null;
  terminalLayout: TerminalLayout;
}
