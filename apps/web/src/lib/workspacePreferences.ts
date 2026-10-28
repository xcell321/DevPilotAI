import { apiGet, apiPatch } from './api';
import type { TerminalLayout, WorkspacePreferences } from './types';

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  version: 1,
  selectedProjectId: null,
  selectedSessionId: null,
  maximizedTerminalId: null,
  terminalLayout: 'auto',
};

export type WorkspacePreferencesPatch = {
  selectedProjectId?: string | null;
  selectedSessionId?: string | null;
  maximizedTerminalId?: string | null;
  terminalLayout?: TerminalLayout;
};

export async function loadWorkspacePreferences(): Promise<WorkspacePreferences> {
  try {
    const result = await apiGet<{ preferences: WorkspacePreferences }>(
      '/api/settings/workspace',
    );
    return result.preferences;
  } catch {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }
}

export async function saveWorkspacePreferences(
  patch: WorkspacePreferencesPatch,
): Promise<WorkspacePreferences> {
  const result = await apiPatch<{ preferences: WorkspacePreferences }>(
    '/api/settings/workspace',
    { version: 1, ...patch },
  );
  return result.preferences;
}
