import type { Migration } from '../migrate';

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema',
  sql: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL COLLATE NOCASE UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE tool_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      fixed_args_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      default_on_quick_start INTEGER NOT NULL DEFAULT 0 CHECK (default_on_quick_start IN (0, 1)),
      last_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (last_status IN ('available', 'missing', 'unknown', 'unverified')),
      last_checked_at TEXT,
      notes TEXT
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'running', 'stopped', 'error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT
    );

    CREATE TABLE session_terminals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool_profile_id TEXT NOT NULL REFERENCES tool_profiles(id) ON DELETE RESTRICT,
      process_status TEXT NOT NULL DEFAULT 'starting'
        CHECK (process_status IN ('starting', 'running', 'exited', 'stopped', 'error')),
      process_pid INTEGER,
      exit_code INTEGER,
      started_at TEXT,
      ended_at TEXT,
      last_error TEXT
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_sessions_project_id ON sessions(project_id);
    CREATE INDEX idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX idx_session_terminals_session_id ON session_terminals(session_id);
    CREATE INDEX idx_session_terminals_tool_profile_id ON session_terminals(tool_profile_id);
    CREATE INDEX idx_session_terminals_process_status ON session_terminals(process_status);
  `,
};
