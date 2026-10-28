import type { Server } from 'node:http';
import type { Db } from '../db/types';
import type { ProcessManager } from './processManager';
import { refreshSessionStatus } from './sessionStatus';

export function reconcileStaleTerminals(
  db: Db,
  now = new Date().toISOString(),
): number {
  const rows = db
    .prepare(
      `SELECT id, session_id
       FROM session_terminals
       WHERE process_status IN ('starting', 'running')`,
    )
    .all() as { id: string; session_id: string }[];

  if (rows.length === 0) return 0;

  const update = db.prepare(
    `UPDATE session_terminals
     SET process_status = 'stopped', process_pid = NULL,
         ended_at = COALESCE(ended_at, ?),
         last_error = 'Backend restarted', error_code = 'backend_restarted'
     WHERE id = ?`,
  );
  const sessions = new Set<string>();
  db.transaction(() => {
    for (const row of rows) {
      update.run(now, row.id);
      sessions.add(row.session_id);
    }
  })();

  for (const sessionId of sessions) {
    refreshSessionStatus(db, sessionId, now);
  }

  return rows.length;
}

export interface ShutdownOptions {
  server: Pick<Server, 'close'>;
  db: Db;
  processManager: ProcessManager;
  cleanup?: () => void;
  timeoutMs?: number;
}

export async function shutdownRuntime(options: ShutdownOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  let managerError: unknown;

  try {
    await options.processManager.shutdown();
  } catch (error) {
    managerError = error;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref();
    options.server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    options.db.close();
  } finally {
    options.cleanup?.();
  }

  if (managerError) throw managerError;
}
