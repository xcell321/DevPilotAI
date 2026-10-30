import type { Server } from 'node:http';
import type { Db } from '../db/types';
import type { ProcessManager } from './processManager';
import { refreshSessionStatus } from './sessionStatus';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited or no permission.
  }
}

export function reconcileStaleTerminals(
  db: Db,
  now = new Date().toISOString(),
): number {
  const rows = db
    .prepare(
      `SELECT id, session_id, process_pid
       FROM session_terminals
       WHERE process_status IN ('starting', 'running')`,
    )
    .all() as { id: string; session_id: string; process_pid: number | null }[];

  if (rows.length === 0) return 0;

  const update = db.prepare(
    `UPDATE session_terminals
     SET process_status = 'stopped', process_pid = NULL,
         ended_at = COALESCE(ended_at, ?),
         last_error = 'Backend restarted', error_code = 'backend_restarted'
     WHERE id = ?`,
  );
  const sessions = new Set<string>();
  let reaped = 0;
  let alreadyGone = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (row.process_pid && isProcessAlive(row.process_pid)) {
        killProcess(row.process_pid);
        reaped += 1;
      } else if (row.process_pid) {
        alreadyGone += 1;
      }
      update.run(now, row.id);
      sessions.add(row.session_id);
    }
  })();

  if (reaped > 0 || alreadyGone > 0) {
    console.log(`[startup] Reconciled ${rows.length} stale terminal(s): ${reaped} process(es) reaped, ${alreadyGone} already gone.`);
  }

  for (const sessionId of sessions) {
    refreshSessionStatus(db, sessionId, now);
  }

  return rows.length;
}

export function reconcileAgentWorkspaces(
  db: Db,
  now = new Date().toISOString(),
): number {
  return db
    .prepare(
      `UPDATE agent_workspaces
       SET status = 'failed',
           last_error = 'Backend restarted during workspace provisioning; inspect the worktree before retrying.',
           updated_at = ?
       WHERE status = 'provisioning'`,
    )
    .run(now).changes;
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
