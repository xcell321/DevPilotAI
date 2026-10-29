import type { AgentTaskState } from '../../../shared/api-types.cjs';

export const SUCCESSFUL_DEPENDENCY_STATES: readonly AgentTaskState[] = ['integrated'];
export const ACTIVE_TASK_STATES: readonly AgentTaskState[] = ['assigned', 'running', 'validating'];
export const TERMINAL_TASK_STATES: readonly AgentTaskState[] = [
  'integrated',
  'failed',
  'cancelled',
];
export const DEFAULT_PROTECTED_PATHS = ['.git'];

export interface TaskDependencyView {
  id: string;
  label: string;
  state: AgentTaskState;
}

export interface DerivedTaskState {
  state: AgentTaskState;
  blockedReason: string | null;
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

export function normalizeRepoPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function isPathWithinScope(file: string, scopeEntry: string): boolean {
  const candidate = normalizeRepoPath(file);
  const boundary = normalizeRepoPath(scopeEntry);
  if (!boundary) return false;
  return samePath(candidate, boundary) || candidate.toLowerCase().startsWith(`${boundary.toLowerCase()}/`);
}

/**
 * A declared scope is a planning boundary. Any changed path outside it is
 * reported for review instead of being accepted silently.
 */
export function findScopeViolations(changedFiles: string[], declaredScope: string[]): string[] {
  if (declaredScope.length === 0) return [];
  return changedFiles.filter(
    (file) => !declaredScope.some((entry) => isPathWithinScope(file, entry)),
  );
}

export function findProtectedViolations(changedFiles: string[], protectedPaths: string[]): string[] {
  const boundaries = [...DEFAULT_PROTECTED_PATHS, ...protectedPaths.map(normalizeRepoPath)].filter(
    Boolean,
  );
  return changedFiles.filter((file) =>
    boundaries.some((entry) => isPathWithinScope(file, entry)),
  );
}

/** Dependencies only count as successful once their work is actually integrated. */
export function isDependencySatisfied(state: AgentTaskState): boolean {
  return SUCCESSFUL_DEPENDENCY_STATES.includes(state);
}

export function describeDependencyBlocker(dependencies: TaskDependencyView[]): string | null {
  const unresolved = dependencies.filter((dependency) => !isDependencySatisfied(dependency.state));
  if (unresolved.length === 0) return null;
  return unresolved
    .map((dependency) => `${dependency.label} is ${dependency.state.replace(/_/g, ' ')}`)
    .join('; ');
}

/**
 * Computes the queued (non-executing) state of a task from its assignment and
 * its recorded dependencies. Running/validating/integrated states are owned by
 * the orchestrator and never derived here.
 */
export function deriveQueuedState(input: {
  description: string;
  currentState: AgentTaskState;
  dependencies: TaskDependencyView[];
  missingDependencies?: string[];
}): DerivedTaskState {
  if (input.currentState === 'integrated') {
    return { state: 'integrated', blockedReason: null };
  }
  if (input.currentState === 'cancelled') {
    return { state: 'cancelled', blockedReason: null };
  }
  if (!input.description.trim()) {
    return { state: 'unassigned', blockedReason: null };
  }
  if ((input.missingDependencies?.length ?? 0) > 0) {
    return {
      state: 'blocked',
      blockedReason: `Unknown dependenc${(input.missingDependencies?.length ?? 0) === 1 ? 'y' : 'ies'}: ${input.missingDependencies!.join(', ')}`,
    };
  }
  const blocker = describeDependencyBlocker(input.dependencies);
  if (blocker) return { state: 'blocked', blockedReason: `Waiting for dependencies: ${blocker}` };
  return { state: 'ready', blockedReason: null };
}
