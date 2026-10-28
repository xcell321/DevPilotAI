import type { Migration } from '../migrate';

export const migration002: Migration = {
  version: 2,
  name: 'project_path_key',
  sql: `
    ALTER TABLE projects ADD COLUMN path_key TEXT;

    UPDATE projects SET path_key = lower(path);

    CREATE UNIQUE INDEX idx_projects_path_key ON projects(path_key);
  `,
};
