import type { Db } from './types';
import { migrations } from './migrations';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  version: number;
}

export function runMigrations(db: Db): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => (row as AppliedMigrationRow).version),
  );

  const applyMigration = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    ).run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) {
      applyMigration(migration);
    }
  }

  const latest = db
    .prepare('SELECT MAX(version) AS version FROM schema_migrations')
    .get() as { version: number | null };
  const version = latest.version ?? 0;
  db.pragma(`user_version = ${version}`);
  return version;
}
