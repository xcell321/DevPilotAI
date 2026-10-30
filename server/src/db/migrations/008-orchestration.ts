import type { Migration } from '../migrate';

export const migration008: Migration = {
  version: 8,
  name: 'task_orchestration',
  sql: `
    ALTER TABLE agent_tasks
      ADD COLUMN state TEXT NOT NULL DEFAULT 'unassigned'
        CHECK (state IN (
          'unassigned', 'blocked', 'ready', 'assigned', 'running',
          'validating', 'awaiting_integration', 'integrated', 'failed', 'cancelled', 'interrupted'
        ));

    ALTER TABLE agent_tasks ADD COLUMN blocked_reason TEXT;
    ALTER TABLE agent_tasks ADD COLUMN completion_summary TEXT;
    ALTER TABLE agent_tasks ADD COLUMN completed_at TEXT;
    ALTER TABLE agent_tasks ADD COLUMN assigned_at TEXT;
    ALTER TABLE agent_tasks ADD COLUMN actual_files_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agent_tasks ADD COLUMN scope_violations_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE agent_tasks ADD COLUMN validation_summary TEXT;
    ALTER TABLE agent_tasks ADD COLUMN integration_reason TEXT;
    ALTER TABLE agent_tasks ADD COLUMN integration_commit TEXT;
    ALTER TABLE agent_tasks ADD COLUMN target_branch TEXT;

    UPDATE agent_tasks
    SET state = CASE
      WHEN status = 'unassigned' THEN 'unassigned'
      WHEN status = 'cancelled' THEN 'cancelled'
      WHEN status = 'failed' THEN 'failed'
      WHEN status = 'completed' THEN 'awaiting_integration'
      WHEN status = 'in_progress' THEN 'running'
      ELSE 'blocked'
    END;

    CREATE TABLE project_orchestration_settings (
      project_id TEXT PRIMARY KEY
        REFERENCES projects(id) ON DELETE CASCADE,
      auto_integrate INTEGER NOT NULL DEFAULT 0
        CHECK (auto_integrate IN (0, 1)),
      max_concurrent_agents INTEGER NOT NULL DEFAULT 2
        CHECK (max_concurrent_agents >= 1),
      target_branch TEXT,
      protected_paths_json TEXT NOT NULL DEFAULT '[]',
      validation_commands_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE task_validations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL
        CHECK (status IN ('running', 'passed', 'failed', 'timed_out', 'cancelled')),
      exit_code INTEGER,
      duration_ms INTEGER,
      output TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE INDEX idx_task_validations_task_id ON task_validations(task_id, started_at);

    CREATE TABLE task_integrations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
      state TEXT NOT NULL
        CHECK (state IN ('queued', 'running', 'integrated', 'rejected', 'failed')),
      target_branch TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_commit TEXT,
      target_commit_before TEXT,
      merge_commit TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      violations_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_task_integrations_task_id ON task_integrations(task_id, created_at);
    CREATE UNIQUE INDEX idx_task_integrations_active
      ON task_integrations(task_id)
      WHERE state IN ('queued', 'running');
  `,
};
