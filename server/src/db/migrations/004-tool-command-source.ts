import type { Migration } from '../migrate';

export const migration004: Migration = {
  version: 4,
  name: 'tool_command_source',
  sql: `
    ALTER TABLE tool_profiles
      ADD COLUMN command_source TEXT NOT NULL DEFAULT 'legacy';
  `,
};
