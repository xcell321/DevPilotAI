import type { Migration } from '../migrate';

export const migration003: Migration = {
  version: 3,
  name: 'session_runtime',
  sql: `
    ALTER TABLE tool_profiles
      ADD COLUMN launch_verified INTEGER NOT NULL DEFAULT 0
      CHECK (launch_verified IN (0, 1));

    UPDATE tool_profiles SET launch_verified = 1 WHERE id = 'claude';

    ALTER TABLE sessions
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'custom'
      CHECK (mode IN ('quick', 'custom'));

    ALTER TABLE session_terminals ADD COLUMN error_code TEXT;
    ALTER TABLE session_terminals ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0;
  `,
};
