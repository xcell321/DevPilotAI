import type { Migration } from '../migrate';

export const migration006: Migration = {
  version: 6,
  name: 'session_workspace_mode',
  sql: `
    ALTER TABLE sessions
      ADD COLUMN workspace_mode TEXT
      CHECK (workspace_mode IS NULL OR workspace_mode IN ('shared', 'isolated'));

    UPDATE sessions
    SET workspace_mode = 'isolated'
    WHERE EXISTS (
      SELECT 1
      FROM session_terminals st
      JOIN agent_workspaces aw ON aw.terminal_id = st.id
      WHERE st.session_id = sessions.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM session_terminals st
      LEFT JOIN agent_workspaces aw ON aw.terminal_id = st.id
      WHERE st.session_id = sessions.id
        AND aw.terminal_id IS NULL
    );
  `,
};
