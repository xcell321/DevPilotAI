import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../errors';
import type { Db } from '../db/types';

const MAX_SCOPE_LENGTH = 512;

export interface ScopeEntry {
  path: string;
  isDirectory: boolean;
}

export interface LeaseConflict {
  path: string;
  ownerTaskId: string;
  ownerTaskLabel: string;
  ownerState: string;
  ownerToolName: string;
  ownerPath: string;
}

export interface LeaseAcquisition {
  ok: boolean;
  conflicts: LeaseConflict[];
  scopes: ScopeEntry[];
}

export interface LeaseRow {
  id: string;
  task_id: string;
  session_id: string;
  project_id: string;
  terminal_id: string;
  tool_profile_id: string;
  path: string;
  path_key: string;
  is_directory: number;
  state: 'active' | 'released';
  reason: string | null;
  acquired_at: string;
  released_at: string | null;
  release_reason: string | null;
  task_description: string;
  task_state: string;
  tool_name: string;
}

export interface ActiveLeaseSummary {
  taskId: string;
  taskLabel: string;
  taskState: string;
  agentToolId: string;
  agentName: string;
  path: string;
  isDirectory: boolean;
  reason: string | null;
  acquiredAt: string;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonical repository-relative path used for every writable lease. Absolute
 * paths, drive letters, traversal, wildcards, `.git` and control characters are
 * rejected instead of being repaired.
 */
export function normalizeLeasePath(raw: string): string {
  const candidate = raw.trim().replace(/\\/g, '/');
  if (
    candidate.length === 0 ||
    candidate.length > MAX_SCOPE_LENGTH ||
    candidate.startsWith('/') ||
    /^[a-zA-Z]:/.test(candidate) ||
    candidate.startsWith('//') ||
    /[*?[\]]/.test(candidate) ||
    hasControlCharacters(candidate)
  ) {
    throw new ApiError(
      400,
      'invalid_task_scope',
      'Writable scopes must be repository-relative paths without wildcards, drive letters, or absolute paths.',
    );
  }
  const segments = candidate.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) {
    throw new ApiError(
      400,
      'invalid_task_scope',
      'Writable scopes cannot be empty and cannot contain parent-directory segments.',
    );
  }
  const normalized = segments.join('/');
  const lower = normalized.toLowerCase();
  if (lower === '.git' || lower.startsWith('.git/')) {
    throw new ApiError(400, 'invalid_task_scope', 'Git internals cannot be claimed as writable scope.');
  }
  return normalized;
}

function isCaseInsensitiveFileSystem(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

export function leasePathKey(normalizedPath: string): string {
  return isCaseInsensitiveFileSystem() ? normalizedPath.toLowerCase() : normalizedPath;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

/**
 * Two writable scopes conflict when they name the same path or when either one
 * is a directory that contains the other.
 */
export function scopesOverlap(first: ScopeEntry, second: ScopeEntry): boolean {
  const left = leasePathKey(first.path);
  const right = leasePathKey(second.path);
  if (left === right) return true;
  if (first.isDirectory && isWithin(left, right)) return true;
  if (second.isDirectory && isWithin(right, left)) return true;
  return false;
}

function isPathInsideRepository(repositoryRoot: string, target: string): boolean {
  const relative = path.relative(repositoryRoot, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Resolves declared scopes to the file/directory entries that can be leased.
 * Existing symlink entries (or scopes whose real path escapes the repository)
 * are rejected so a lease can never cover an unrelated file.
 */
export function resolveScopeEntries(repositoryRoot: string, rawScopes: string[]): ScopeEntry[] {
  const root = path.resolve(repositoryRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch {
    throw new ApiError(409, 'git_workspace_unavailable', 'The repository root is unavailable.');
  }

  const entries: ScopeEntry[] = [];
  for (const raw of rawScopes) {
    const normalized = normalizeLeasePath(raw);
    const absolute = path.resolve(root, normalized);
    if (!isPathInsideRepository(root, absolute)) {
      throw new ApiError(400, 'invalid_task_scope', 'Writable scopes cannot escape the repository.');
    }

    let exists = false;
    let isDirectory = raw.trim().endsWith('/');
    try {
      const lstat = fs.lstatSync(absolute);
      if (lstat.isSymbolicLink()) {
        throw new ApiError(
          400,
          'invalid_task_scope',
          `The writable scope "${normalized}" is a symbolic link, which cannot be leased safely.`,
        );
      }
      exists = true;
      isDirectory = lstat.isDirectory();
      const realTarget = fs.realpathSync.native(absolute);
      if (!isPathInsideRepository(realRoot, realTarget)) {
        throw new ApiError(
          400,
          'invalid_task_scope',
          `The writable scope "${normalized}" resolves outside the repository.`,
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ApiError(
          400,
          'invalid_task_scope',
          `The writable scope "${normalized}" could not be inspected safely.`,
        );
      }
    }

    if (!exists) {
      // A scope that does not exist yet is a planned file (or an explicitly
      // marked directory). Its parent must still resolve inside the repository.
      const parent = path.dirname(absolute);
      try {
        const realParent = fs.realpathSync.native(parent);
        if (!isPathInsideRepository(realRoot, realParent)) {
          throw new ApiError(
            400,
            'invalid_task_scope',
            `The writable scope "${normalized}" resolves outside the repository.`,
          );
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // A missing parent chain cannot be resolved yet; the path itself was
        // already checked to be repository-relative.
      }
    }

    entries.push({ path: normalized, isDirectory });
  }
  return entries;
}

function conflictLabel(row: LeaseRow): string {
  const description = row.task_description.trim();
  return description.length > 0 ? description.slice(0, 120) : row.task_id.slice(0, 8);
}

/**
 * Persistent, atomic writable-scope ownership. Active leases are unique per
 * canonical path and container checks are evaluated inside the same database
 * transaction that inserts them, so two scheduler requests cannot both claim
 * the same file.
 */
export class FileLeaseService {
  constructor(private readonly db: Db) {}

  activeLeases(projectId: string): LeaseRow[] {
    return this.db
      .prepare(
        `SELECT l.*, at.description AS task_description, at.state AS task_state,
                tp.display_name AS tool_name
         FROM agent_task_leases l
         JOIN agent_tasks at ON at.id = l.task_id
         JOIN tool_profiles tp ON tp.id = l.tool_profile_id
         WHERE l.project_id = ? AND l.state = 'active'
         ORDER BY l.path, l.acquired_at`,
      )
      .all(projectId) as LeaseRow[];
  }

  activeForTask(taskId: string): LeaseRow[] {
    return this.db
      .prepare(
        `SELECT l.*, at.description AS task_description, at.state AS task_state,
                tp.display_name AS tool_name
         FROM agent_task_leases l
         JOIN agent_tasks at ON at.id = l.task_id
         JOIN tool_profiles tp ON tp.id = l.tool_profile_id
         WHERE l.task_id = ? AND l.state = 'active'
         ORDER BY l.path`,
      )
      .all(taskId) as LeaseRow[];
  }

  conflicts(
    projectId: string,
    scopes: ScopeEntry[],
    options: { ignoreTaskId?: string } = {},
  ): LeaseConflict[] {
    const holders = this.activeLeases(projectId).filter(
      (row) => row.task_id !== options.ignoreTaskId,
    );
    const conflicts: LeaseConflict[] = [];
    for (const scope of scopes) {
      for (const holder of holders) {
        const holderScope: ScopeEntry = {
          path: holder.path,
          isDirectory: holder.is_directory === 1,
        };
        if (!scopesOverlap(scope, holderScope)) continue;
        conflicts.push({
          path: scope.path,
          ownerTaskId: holder.task_id,
          ownerTaskLabel: conflictLabel(holder),
          ownerState: holder.task_state,
          ownerToolName: holder.tool_name,
          ownerPath: holder.path,
        });
      }
    }
    return conflicts;
  }

  /** Scopes from `scopes` that do not conflict with any other active lease. */
  freeScopes(
    projectId: string,
    scopes: ScopeEntry[],
    taskId: string,
  ): ScopeEntry[] {
    return scopes.filter(
      (scope) => this.conflicts(projectId, [scope], { ignoreTaskId: taskId }).length === 0,
    );
  }

  acquire(input: {
    taskId: string;
    sessionId: string;
    projectId: string;
    terminalId: string;
    toolProfileId: string;
    scopes: ScopeEntry[];
  }): LeaseAcquisition {
    const conflicts = this.conflicts(input.projectId, input.scopes, {
      ignoreTaskId: input.taskId,
    });
    if (conflicts.length > 0) {
      return { ok: false, conflicts, scopes: input.scopes };
    }

    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        const existing = this.db.prepare(
          `SELECT path_key FROM agent_task_leases
           WHERE task_id = ? AND state = 'active'`,
        );
        const insert = this.db.prepare(
          `INSERT INTO agent_task_leases (
             id, task_id, session_id, project_id, terminal_id, tool_profile_id,
             path, path_key, is_directory, state, reason, acquired_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
        );
        const owned = new Set(
          (existing.all(input.taskId) as Array<{ path_key: string }>).map((row) => row.path_key),
        );
        for (const scope of input.scopes) {
          const key = leasePathKey(scope.path);
          if (owned.has(key)) continue;
          insert.run(
            crypto.randomUUID(),
            input.taskId,
            input.sessionId,
            input.projectId,
            input.terminalId,
            input.toolProfileId,
            scope.path,
            key,
            scope.isDirectory ? 1 : 0,
            now,
          );
        }
      })();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return {
          ok: false,
          conflicts: this.conflicts(input.projectId, input.scopes, {
            ignoreTaskId: input.taskId,
          }),
          scopes: input.scopes,
        };
      }
      throw error;
    }
    return { ok: true, conflicts: [], scopes: input.scopes };
  }

  releaseTask(taskId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE agent_task_leases
         SET state = 'released', released_at = ?, release_reason = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(new Date().toISOString(), reason, taskId).changes;
  }

  /** Force-releases all active leases for a task, regardless of task state. Admin-only. */
  forceReleaseTask(taskId: string, reason: string): number {
    return this.db
      .prepare(
        `UPDATE agent_task_leases
         SET state = 'released', released_at = ?, release_reason = ?
         WHERE task_id = ? AND state = 'active'`,
      )
      .run(new Date().toISOString(), reason, taskId).changes;
  }

  /** Records why an active lease is still being held (for the waiting UI). */
  setHoldReason(taskId: string, reason: string | null): void {
    this.db
      .prepare(`UPDATE agent_task_leases SET reason = ? WHERE task_id = ? AND state = 'active'`)
      .run(reason, taskId);
  }

  summarize(projectId: string, sessionId?: string): ActiveLeaseSummary[] {
    return this.activeLeases(projectId)
      .filter((row) => sessionId === undefined || row.session_id === sessionId)
      .map((row) => ({
        taskId: row.task_id,
        taskLabel: conflictLabel(row),
        taskState: row.task_state,
        agentToolId: row.tool_profile_id,
        agentName: row.tool_name,
        path: row.path,
        isDirectory: row.is_directory === 1,
        reason: row.reason,
        acquiredAt: row.acquired_at,
      }));
  }
}
