/**
 * Per-task configuration for the workflow picker.
 * Lets the user override the planner's auto-assigned CLI per task —
 * essential for free-tier quota management (switch CLI when one runs out).
 */

export interface TaskOverride {
  /** Override the planner's auto-assigned CLI. Undefined = use planner's choice. */
  toolId?: string;
  /** Model for this task. Auto-selected from DEFAULT_MODELS when CLI changes. */
  model?: string;
  /** Skills to inject into this task's agent prompt. */
  skills?: string[];
}

/** Default model per CLI. GitHub Copilot is automatic (no default). */
export const DEFAULT_MODELS: Record<string, string> = {
  antigravity: 'Gemini 3.8 Flash (medium)',
  opencode: 'DeepSeek V4.1 Flash (free)',
  freebuff: 'DeepSeek V4.1 Flash (free)',
  'claude-code': 'FreeLLMAPI',
};

/** Available models per CLI for the dropdown. */
export const MODELS_BY_CLI: Record<string, string[]> = {
  antigravity: ['Gemini 3.8 Flash (medium)', 'Gemini 3.8 Flash (high)', 'Gemini 3.8 Pro'],
  opencode: ['DeepSeek V4.1 Flash (free)', 'DeepSeek V4.1 (free)'],
  freebuff: ['DeepSeek V4.1 Flash (free)', 'DeepSeek V4.1 (free)'],
  'claude-code': ['FreeLLMAPI'],
  'github-copilot': ['Automatic'],
};

/** Skills available for task agents. Loaded dynamically in the future. */
export const AVAILABLE_SKILLS: Array<{ id: string; name: string; description: string }> = [
  { id: 'api-security', name: 'API Security', description: '12 API security rules' },
  { id: 'owasp-top10', name: 'OWASP Top 10', description: 'Web security fundamentals' },
  { id: 'backend-performance', name: 'Backend Performance', description: 'Caching, N+1, indexing' },
  { id: 'devops-basics', name: 'DevOps Basics', description: 'CI/CD, Docker, logging' },
  { id: 'debug-first', name: 'Debug First', description: 'Root-cause debugging' },
  { id: 'safe-editing', name: 'Safe Editing', description: 'Senior-dev edit discipline' },
  { id: 'design-taste-frontend', name: 'Design Taste', description: 'Anti-slop frontend taste' },
  { id: 'ui-ux-pro-max', name: 'UI/UX Pro Max', description: 'UI/UX intelligence' },
  { id: 'ux-edge-states', name: 'UX Edge States', description: 'Loading, error, empty states' },
  { id: 'ub-mode', name: 'UB Mode', description: 'TDD + clean code discipline' },
  { id: 'caveman', name: 'Caveman', description: 'Token-efficient output' },
  { id: 'audit-team', name: 'Audit Team', description: '5-agent code audit' },
];

/** Get the default model for a CLI, or undefined if none. */
export function defaultModelFor(toolId: string): string | undefined {
  return DEFAULT_MODELS[toolId];
}

/** Get the model options for a CLI. */
export function modelsFor(toolId: string): string[] {
  return MODELS_BY_CLI[toolId] ?? ['Default'];
}
