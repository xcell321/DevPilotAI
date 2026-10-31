import type { Migration } from '../migrate';

export const migration012: Migration = {
  version: 12,
  name: 'session_terminals_task_description',
  sql: `
    ALTER TABLE session_terminals
      ADD COLUMN task_description TEXT;
  `,
};
