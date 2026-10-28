import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate';
import type { Db } from './types';

export { runMigrations } from './migrate';

export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
