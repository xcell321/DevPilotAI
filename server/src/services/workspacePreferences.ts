import type {
  TerminalLayout,
  WorkspacePreferences,
} from '../../../shared/api-types.cjs';
import { WORKSPACE_PREFERENCES_VERSION } from '../../../shared/contracts.cjs';
import type { Db } from '../db/types';

export { WORKSPACE_PREFERENCES_VERSION };
export type { TerminalLayout, WorkspacePreferences };

export const WORKSPACE_PREFERENCES_KEY = 'workspace.preferences';

export interface WorkspacePreferencesPatch {
  version: typeof WORKSPACE_PREFERENCES_VERSION;
  selectedProjectId?: string | null;
  selectedSessionId?: string | null;
  maximizedTerminalId?: string | null;
  terminalLayout?: TerminalLayout;
}

interface StoredPreferencesRow {
  value_json: string;
}

const TERMINAL_LAYOUTS = new Set<TerminalLayout>([
  'auto',
  'single',
  'horizontal',
  'vertical',
  'grid',
]);

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  version: WORKSPACE_PREFERENCES_VERSION,
  selectedProjectId: null,
  selectedSessionId: null,
  maximizedTerminalId: null,
  terminalLayout: 'auto',
};

function optionalId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return trimmed;
}

function readStoredJson(db: Db): unknown {
  const row = db
    .prepare('SELECT value_json FROM app_settings WHERE key = ?')
    .get(WORKSPACE_PREFERENCES_KEY) as StoredPreferencesRow | undefined;
  if (!row) return null;

  try {
    return JSON.parse(row.value_json) as unknown;
  } catch {
    return null;
  }
}

function parseStoredPreferences(value: unknown): WorkspacePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== WORKSPACE_PREFERENCES_VERSION) {
    return { ...DEFAULT_WORKSPACE_PREFERENCES };
  }

  return {
    version: WORKSPACE_PREFERENCES_VERSION,
    selectedProjectId: optionalId(candidate.selectedProjectId),
    selectedSessionId: optionalId(candidate.selectedSessionId),
    maximizedTerminalId: optionalId(candidate.maximizedTerminalId),
    terminalLayout: TERMINAL_LAYOUTS.has(candidate.terminalLayout as TerminalLayout)
      ? (candidate.terminalLayout as TerminalLayout)
      : 'auto',
  };
}

function exists(db: Db, table: 'projects' | 'sessions', id: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));
}

function terminalBelongsToSession(
  db: Db,
  terminalId: string,
  sessionId: string | null,
): boolean {
  if (!sessionId) return false;
  return Boolean(
    db
      .prepare('SELECT 1 FROM session_terminals WHERE id = ? AND session_id = ?')
      .get(terminalId, sessionId),
  );
}

function resolveAgainstDatabase(
  db: Db,
  preferences: WorkspacePreferences,
): WorkspacePreferences {
  const selectedProjectId =
    preferences.selectedProjectId && exists(db, 'projects', preferences.selectedProjectId)
      ? preferences.selectedProjectId
      : null;
  const selectedSessionId =
    preferences.selectedSessionId && exists(db, 'sessions', preferences.selectedSessionId)
      ? preferences.selectedSessionId
      : null;
  const maximizedTerminalId =
    preferences.maximizedTerminalId &&
    terminalBelongsToSession(db, preferences.maximizedTerminalId, selectedSessionId)
      ? preferences.maximizedTerminalId
      : null;

  return {
    version: WORKSPACE_PREFERENCES_VERSION,
    selectedProjectId,
    selectedSessionId,
    maximizedTerminalId,
    terminalLayout: preferences.terminalLayout,
  };
}

export function getWorkspacePreferences(db: Db): WorkspacePreferences {
  return resolveAgainstDatabase(db, parseStoredPreferences(readStoredJson(db)));
}

export function updateWorkspacePreferences(
  db: Db,
  patch: WorkspacePreferencesPatch,
  now = new Date().toISOString(),
): WorkspacePreferences {
  const current = getWorkspacePreferences(db);
  const next: WorkspacePreferences = {
    version: WORKSPACE_PREFERENCES_VERSION,
    selectedProjectId:
      patch.selectedProjectId === undefined
        ? current.selectedProjectId
        : patch.selectedProjectId,
    selectedSessionId:
      patch.selectedSessionId === undefined
        ? current.selectedSessionId
        : patch.selectedSessionId,
    maximizedTerminalId:
      patch.maximizedTerminalId === undefined
        ? current.maximizedTerminalId
        : patch.maximizedTerminalId,
    terminalLayout: patch.terminalLayout ?? current.terminalLayout,
  };

  if (patch.selectedSessionId !== undefined && patch.maximizedTerminalId === undefined) {
    next.maximizedTerminalId = null;
  }

  const resolved = resolveAgainstDatabase(db, next);
  db.prepare(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(WORKSPACE_PREFERENCES_KEY, JSON.stringify(resolved), now);

  return resolved;
}
