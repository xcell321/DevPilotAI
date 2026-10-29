import type { Migration } from '../migrate';

export const migration010: Migration = {
  version: 10,
  name: 'workflow_coordination',
  sql: `
    ALTER TABLE agent_tasks ADD COLUMN wait_kind TEXT
      CHECK (wait_kind IN ('dependency', 'files'));
    ALTER TABLE agent_tasks ADD COLUMN deferred_scope_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agent_tasks ADD COLUMN replan_count INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE project_orchestration_settings ADD COLUMN scheduling_paused INTEGER NOT NULL DEFAULT 0
      CHECK (scheduling_paused IN (0, 1));

    CREATE TABLE agent_task_leases (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      terminal_id TEXT NOT NULL,
      tool_profile_id TEXT NOT NULL REFERENCES tool_profiles(id) ON DELETE RESTRICT,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL,
      is_directory INTEGER NOT NULL DEFAULT 0
        CHECK (is_directory IN (0, 1)),
      state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'released')),
      reason TEXT,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      release_reason TEXT
    );

    CREATE INDEX idx_agent_task_leases_project
      ON agent_task_leases(project_id, state);
    CREATE INDEX idx_agent_task_leases_task
      ON agent_task_leases(task_id, state);
    CREATE UNIQUE INDEX idx_agent_task_leases_active_path
      ON agent_task_leases(path_key)
      WHERE state = 'active';

    CREATE TABLE task_replans (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      previous_scope_json TEXT NOT NULL,
      new_scope_json TEXT NOT NULL,
      deferred_scope_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_task_replans_task ON task_replans(task_id, created_at);

    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'paused', 'completed', 'cancelled', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_workflow_runs_project ON workflow_runs(project_id, created_at);
  `,
};
