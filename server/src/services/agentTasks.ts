import path from 'node:path';
import { ApiError } from '../errors';

const MAX_TASK_DESCRIPTION_LENGTH = 4000;
const MAX_TASK_SCOPE_ITEMS = 100;
const MAX_TASK_SCOPE_PATH_LENGTH = 512;
const MAX_TASK_DEPENDENCIES = 32;

export interface AgentTaskDraft {
  toolId: string;
  description?: string;
  declaredFileScope?: string[];
  dependencies?: string[];
}

export interface NormalizedAgentTaskDraft {
  toolId: string;
  description: string;
  declaredFileScope: string[];
  dependencies: string[];
}

function normalizeScope(scope: string[]): string[] {
  if (scope.length > MAX_TASK_SCOPE_ITEMS) {
    throw new ApiError(400, 'invalid_task_scope', 'A task can declare at most 100 file paths.');
  }

  const normalized = scope.map((entry) => {
    const candidate = entry.trim().replace(/\\/g, '/');
    if (
      candidate.length === 0 ||
      candidate.length > MAX_TASK_SCOPE_PATH_LENGTH ||
      candidate.startsWith('/') ||
      /^[a-zA-Z]:/.test(candidate) ||
      candidate.split('/').includes('..') ||
      /[*?[\]]/.test(candidate)
    ) {
      throw new ApiError(
        400,
        'invalid_task_scope',
        'Declared file scope must contain repository-relative paths without wildcards or parent-directory segments.',
      );
    }
    const normalizedPath = path.posix.normalize(candidate);
    if (normalizedPath === '.' || normalizedPath === '..') {
      throw new ApiError(400, 'invalid_task_scope', 'Declared file scope paths cannot refer to the repository root.');
    }
    return normalizedPath;
  });

  return [...new Set(normalized)];
}

function scopesOverlap(first: string, second: string): boolean {
  const left = process.platform === 'win32' ? first.toLowerCase() : first;
  const right = process.platform === 'win32' ? second.toLowerCase() : second;
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function validateDependencyGraph(tasks: NormalizedAgentTaskDraft[]): void {
  const taskIds = new Set(tasks.map((task) => task.toolId));
  const state = new Map<string, 'visiting' | 'visited'>();
  const byId = new Map(tasks.map((task) => [task.toolId, task]));

  const visit = (taskId: string) => {
    if (state.get(taskId) === 'visiting') {
      throw new ApiError(400, 'task_dependency_cycle', 'Task dependencies cannot contain a cycle.');
    }
    if (state.get(taskId) === 'visited') return;
    state.set(taskId, 'visiting');
    for (const dependency of byId.get(taskId)?.dependencies ?? []) {
      if (!taskIds.has(dependency)) {
        throw new ApiError(
          400,
          'invalid_task_dependency',
          'Task dependencies must refer to another agent in the same session.',
        );
      }
      if (dependency === taskId) {
        throw new ApiError(400, 'invalid_task_dependency', 'A task cannot depend on itself.');
      }
      visit(dependency);
    }
    state.set(taskId, 'visited');
  };

  for (const task of tasks) visit(task.toolId);
}

function validateScopes(tasks: NormalizedAgentTaskDraft[]): void {
  for (let firstIndex = 0; firstIndex < tasks.length; firstIndex += 1) {
    const first = tasks[firstIndex]!;
    for (const second of tasks.slice(firstIndex + 1)) {
      const overlap = first.declaredFileScope.some((firstPath) =>
        second.declaredFileScope.some((secondPath) => scopesOverlap(firstPath, secondPath)),
      );
      if (overlap) {
        throw new ApiError(
          409,
          'task_scope_overlap',
          `Declared file scopes for ${first.toolId} and ${second.toolId} overlap. Reassign files before launching these agents.`,
        );
      }
    }
  }
}

export function normalizeAgentTaskDrafts(
  toolIds: string[],
  drafts: AgentTaskDraft[] = [],
): NormalizedAgentTaskDraft[] {
  if (new Set(toolIds).size !== toolIds.length) {
    throw new ApiError(400, 'invalid_task_assignment', 'Each agent must have a unique task assignment.');
  }

  const byToolId = new Map<string, AgentTaskDraft>();
  for (const draft of drafts) {
    if (byToolId.has(draft.toolId) || !toolIds.includes(draft.toolId)) {
      throw new ApiError(
        400,
        'invalid_task_assignment',
        'Task assignments must refer to one selected agent and cannot be duplicated.',
      );
    }
    byToolId.set(draft.toolId, draft);
  }

  const tasks = toolIds.map((toolId) => {
    const draft = byToolId.get(toolId);
    const description = (draft?.description ?? '').trim();
    const dependencies = [...new Set(draft?.dependencies ?? [])];
    if (description.length > MAX_TASK_DESCRIPTION_LENGTH) {
      throw new ApiError(400, 'invalid_task_description', 'Task descriptions cannot exceed 4000 characters.');
    }
    if (dependencies.length > MAX_TASK_DEPENDENCIES) {
      throw new ApiError(400, 'invalid_task_dependency', 'A task can depend on at most 32 agents.');
    }
    return {
      toolId,
      description,
      declaredFileScope: normalizeScope(draft?.declaredFileScope ?? []),
      dependencies,
    };
  });

  validateDependencyGraph(tasks);
  validateScopes(tasks);
  return tasks;
}
