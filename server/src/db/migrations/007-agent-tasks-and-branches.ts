import type { Migration } from '../migrate';

export const migration007: Migration = {
  version: 7,
  name: 'agent_tasks_and_branches',
  sql: `
    ALTER TABLE agent_workspaces
      ADD COLUMN branch_name TEXT;

    CREATE TABLE agent_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
        REFERENCES sessions(id) ON DELETE CASCADE,
      terminal_id TEXT NOT NULL UNIQUE
        REFERENCES session_terminals(id) ON DELETE CASCADE,
      description TEXT NOT NULL DEFAULT '',
      declared_file_scope_json TEXT NOT NULL DEFAULT '[]',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL
        CHECK (status IN ('unassigned', 'planned', 'in_progress', 'completed', 'failed', 'cancelled')),
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      validation_status TEXT NOT NULL DEFAULT 'not_configured'
        CHECK (validation_status IN ('not_configured', 'pending', 'passed', 'failed')),
      integration_status TEXT NOT NULL DEFAULT 'not_requested'
        CHECK (integration_status IN ('not_requested', 'queued', 'integrated', 'conflict', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO agent_tasks (
      id, session_id, terminal_id, description, declared_file_scope_json,
      dependencies_json, status, changed_files_json, validation_status,
      integration_status, created_at, updated_at
    )
    SELECT st.id, st.session_id, st.id, '', '[]', '[]', 'unassigned', '[]',
           'not_configured', 'not_requested',
           COALESCE(st.started_at, s.created_at), s.updated_at
    FROM session_terminals st
    JOIN sessions s ON s.id = st.session_id;
  `,
};
