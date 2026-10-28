const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(os.tmpdir(), `devpilot-sqlite-check-${process.pid}.db`);

try {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO projects (id, path) VALUES (?, ?)').run('p1', 'C:\\CAPSTONE\\DevPilotAI');
  db.close();

  const reopened = new Database(dbPath, { readonly: true });
  const row = reopened.prepare('SELECT id, path FROM projects WHERE id = ?').get('p1');
  reopened.close();

  if (!row || row.path !== 'C:\\CAPSTONE\\DevPilotAI') {
    throw new Error('SQLite round-trip did not return the expected row.');
  }

  console.log(`PASS better-sqlite3 ${require('better-sqlite3/package.json').version} created, wrote, and reopened a database`);
  console.log(`PASS SQLite persisted a Windows path with backslashes: ${row.path}`);
} finally {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
}
