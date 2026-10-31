import type { Migration } from '../migrate';

export const migration013: Migration = {
  version: 13,
  name: 'default_max_concurrent_agents_8',
  sql: `
    -- Update existing projects that still have the old default (2) to the new default (8).
    -- Projects with a custom value (not 2) are left untouched.
    UPDATE project_orchestration_settings
      SET max_concurrent_agents = 8
      WHERE max_concurrent_agents = 2;
  `,
};
