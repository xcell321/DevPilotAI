import type { Migration } from '../migrate';

export const migration009: Migration = {
  version: 9,
  name: 'integration_candidate_validation',
  sql: `
    ALTER TABLE task_integrations ADD COLUMN candidate_commit TEXT;
    ALTER TABLE task_integrations ADD COLUMN validation_summary TEXT;

    ALTER TABLE task_validations
      ADD COLUMN phase TEXT NOT NULL DEFAULT 'task'
        CHECK (phase IN ('task', 'integration'));
  `,
};
