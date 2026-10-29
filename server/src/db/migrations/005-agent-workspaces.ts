import type { Migration } from '../migrate';

export const migration005: Migration = {
  version: 5,
  name: 'agent_workspaces',
  sql: `
    CREATE TABLE agent_workspaces (
      terminal_id TEXT PRIMARY KEY
        REFERENCES session_terminals(id) ON DELETE CASCADE,
      owner_tool_profile_id TEXT NOT NULL
        REFERENCES tool_profiles(id) ON DELETE RESTRICT,
      task_title TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      working_directory TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('provisioning', 'ready', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
};
