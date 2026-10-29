import type { Migration } from '../migrate';

export const migration011: Migration = {
  version: 11,
  name: 'lease_index_project_scope',
  sql: `
    DROP INDEX IF EXISTS idx_agent_task_leases_active_path;

    CREATE UNIQUE INDEX idx_agent_task_leases_active_project_path
      ON agent_task_leases(project_id, path_key)
      WHERE state = 'active';
  `,
};
