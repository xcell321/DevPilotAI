import type { Db } from '../db/types';

export type SessionDisplayStatus =
  | 'created'
  | 'starting'
  | 'running'
  | 'exited'
  | 'stopped'
  | 'error'
  | 'unavailable';

export type TerminalDisplayStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'stopped'
  | 'error'
  | 'unavailable';

export interface TerminalStatusRow {
  process_status: string;
  error_code: string | null;
}

export function displayTerminalStatus(
  processStatus: string,
  errorCode: string | null,
): TerminalDisplayStatus {
  if (processStatus === 'stopped' && errorCode === 'backend_restarted') return 'unavailable';
  if (
    processStatus === 'starting' ||
    processStatus === 'running' ||
    processStatus === 'exited' ||
    processStatus === 'stopped' ||
    processStatus === 'error'
  ) {
    return processStatus;
  }
  return 'error';
}

export function deriveSessionStatus(terminals: TerminalStatusRow[]): SessionDisplayStatus {
  if (terminals.length === 0) return 'created';
  const statuses = terminals.map((terminal) =>
    displayTerminalStatus(terminal.process_status, terminal.error_code),
  );
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('starting')) return 'starting';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('exited')) return 'exited';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'stopped';
}

export function toPersistedSessionStatus(status: SessionDisplayStatus): string {
  if (status === 'starting' || status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'created') return 'created';
  return 'stopped';
}

export function refreshSessionStatus(
  db: Db,
  sessionId: string,
  now = new Date().toISOString(),
): SessionDisplayStatus {
  const rows = db
    .prepare('SELECT process_status, error_code FROM session_terminals WHERE session_id = ?')
    .all(sessionId) as TerminalStatusRow[];
  const status = deriveSessionStatus(rows);
  db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run(
    toPersistedSessionStatus(status),
    now,
    sessionId,
  );
  return status;
}
