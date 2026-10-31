import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../../../shared/api-types.cjs';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import {
  deriveProjectName,
  getProjectPathStatus,
  validateProjectPath,
} from './projectPaths';
import { inspectGitRepository, removeGitWorktree } from './gitWorkspaces';

export type ProjectSummary = Project;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  sessions_count: number;
}

const PROJECT_COLUMNS = `
  p.id,
  p.name,
  p.path,
  p.created_at,
  p.updated_at,
  p.last_used_at,
  (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions_count
`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

async function toSummary(row: ProjectRow): Promise<ProjectSummary> {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    sessionsCount: Number(row.sessions_count),
    pathStatus: await getProjectPathStatus(row.path),
  };
}

const MAX_SEARCH_QUERY_LENGTH = 100;

export async function listProjects(db: Db, query: string | undefined): Promise<ProjectSummary[]> {
  const search = (query ?? '').trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  const rows = search
    ? (db
        .prepare(
          `SELECT ${PROJECT_COLUMNS}
           FROM projects p
           WHERE p.name LIKE ? ESCAPE '\\' OR p.path LIKE ? ESCAPE '\\'
           ORDER BY p.name COLLATE NOCASE ASC`,
        )
        .all(`%${escapeLike(search)}%`, `%${escapeLike(search)}%`) as ProjectRow[])
    : (db
        .prepare(
          `SELECT ${PROJECT_COLUMNS}
           FROM projects p
           ORDER BY p.name COLLATE NOCASE ASC`,
        )
        .all() as ProjectRow[]);

  return Promise.all(rows.map(toSummary));
}

async function findProjectRow(db: Db, id: string): Promise<ProjectRow> {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects p WHERE p.id = ?`)
    .get(id) as ProjectRow | undefined;

  if (!row) {
    throw new ApiError(404, 'project_not_found', 'Project not found.');
  }
  return row;
}

export async function getProject(db: Db, id: string): Promise<ProjectSummary> {
  return toSummary(await findProjectRow(db, id));
}

export async function createProject(
  db: Db,
  input: { path: string; name?: string },
): Promise<ProjectSummary> {
  const validated = await validateProjectPath(input.path);
  const name = input.name?.trim() || deriveProjectName(validated.path);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  try {
    db.prepare(
      `INSERT INTO projects (id, name, path, path_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, validated.path, validated.pathKey, now, now);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      throw new ApiError(409, 'duplicate_project', 'That folder is already registered.');
    }
    throw error;
  }

  return getProject(db, id);
}

export async function renameProject(
  db: Db,
  id: string,
  name: string,
): Promise<ProjectSummary> {
  const trimmed = name.trim();
  const result = db
    .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
    .run(trimmed, new Date().toISOString(), id);

  if (result.changes === 0) {
    throw new ApiError(404, 'project_not_found', 'Project not found.');
  }
  return getProject(db, id);
}

export function deleteProject(db: Db, id: string): void {
  const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(id);
  if (!existing) {
    throw new ApiError(404, 'project_not_found', 'Project not found.');
  }

  const sessionCount = (
    db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE project_id = ?').get(id) as {
      count: number;
    }
  ).count;
  const terminalCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM session_terminals st
         JOIN sessions s ON s.id = st.session_id
         WHERE s.project_id = ?`,
      )
      .get(id) as { count: number }
  ).count;

  if (Number(sessionCount) > 0 || Number(terminalCount) > 0) {
    throw new ApiError(
      409,
      'project_in_use',
      'This project has saved sessions or terminals. Remove those records before removing the project.',
    );
  }

  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export interface WorktreeCleanupResult {
  removed: number;
  failed: string[];
  skippedInUse: string[];
}

/**
 * Removes all isolated worktrees for a project from the runtime directory.
 * Only targets directories under <runtimeDir>/worktrees/<repoKey>/.
 * Never touches the main project folder or .git.
 * Skips worktrees currently in use by live terminals.
 */
export async function cleanupProjectWorktrees(
  db: Db,
  runtimeDir: string | null,
  projectId: string,
  isWorktreeInUse?: (worktreePath: string) => boolean,
): Promise<WorktreeCleanupResult> {
  if (!runtimeDir) {
    throw new ApiError(500, 'workspace_configuration_missing', 'The isolated workspace directory is not configured.');
  }

  const row = db.prepare('SELECT id, path FROM projects WHERE id = ?').get(projectId) as
    | { id: string; path: string }
    | undefined;
  if (!row) throw new ApiError(404, 'project_not_found', 'Project not found.');

  // Find the git repository root for this project
  let repositoryRoot: string;
  try {
    const snapshot = await inspectGitRepository(row.path);
    repositoryRoot = snapshot.repositoryRoot;
  } catch {
    // Not a git repo — nothing to clean up
    return { removed: 0, failed: [], skippedInUse: [] };
  }

  // Compute the repository key (same algorithm as getGitWorkspacePaths)
  const repositoryKey = crypto
    .createHash('sha256')
    .update(path.resolve(repositoryRoot).toLowerCase())
    .digest('hex')
    .slice(0, 16);

  const worktreesBase = path.join(runtimeDir, 'worktrees', repositoryKey);
  if (!fs.existsSync(worktreesBase)) {
    return { removed: 0, failed: [], skippedInUse: [] };
  }

  const result: WorktreeCleanupResult = { removed: 0, failed: [], skippedInUse: [] };

  // Walk: worktrees/<repoKey>/<sessionId>/<terminalId>
  const sessionDirs = fs.readdirSync(worktreesBase, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const sessionDir of sessionDirs) {
    const sessionPath = path.join(worktreesBase, sessionDir.name);
    const terminalDirs = fs.readdirSync(sessionPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const terminalDir of terminalDirs) {
      const worktreePath = path.join(sessionPath, terminalDir.name);
      // Safety: ensure we're still under the worktrees base
      const resolved = path.resolve(worktreePath);
      if (!resolved.startsWith(path.resolve(worktreesBase) + path.sep)) continue;

      if (isWorktreeInUse?.(resolved)) {
        result.skippedInUse.push(worktreePath);
        continue;
      }
      try {
        await removeGitWorktree(repositoryRoot, worktreePath);
        // Remove empty parent session dir
        try {
          if (fs.readdirSync(sessionPath).length === 0) fs.rmdirSync(sessionPath);
        } catch { /* ignore */ }
        result.removed++;
      } catch {
        result.failed.push(worktreePath);
      }
    }
  }

  return result;
}
