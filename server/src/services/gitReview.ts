import path from 'node:path';
import { ApiError } from '../errors';
import { runGitCommand } from './gitWorkspaces';

export type ChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typechange'
  | 'untracked';

export interface ChangedFile {
  path: string;
  previousPath: string | null;
  status: ChangeKind;
}

export interface MergeCheck {
  clean: boolean;
  tree: string | null;
  conflicts: string[];
}

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'DevPilot AI',
  GIT_AUTHOR_EMAIL: 'devpilot@localhost',
  GIT_COMMITTER_NAME: 'DevPilot AI',
  GIT_COMMITTER_EMAIL: 'devpilot@localhost',
  GIT_TERMINAL_PROMPT: '0',
};

const STATUS_MAP: Record<string, ChangeKind> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'modified',
};

function gitFailure(result: { code: number; stderr: string }, action: string): ApiError {
  const detail = result.stderr.trim().split(/\r?\n/)[0] ?? '';
  return new ApiError(
    409,
    'git_command_failed',
    detail ? `${action}: ${detail}` : `${action}. Git exited with code ${result.code}.`,
  );
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runGitCommand(cwd, args, { timeoutMs, env: GIT_ENV });
}

export async function resolveCommitOrNull(repositoryRoot: string, ref: string): Promise<string | null> {
  const result = await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

export async function requireCommit(repositoryRoot: string, ref: string): Promise<string> {
  const commit = await resolveCommitOrNull(repositoryRoot, ref);
  if (!commit) {
    throw new ApiError(409, 'git_ref_missing', `Git reference "${ref}" does not exist.`);
  }
  return commit;
}

export async function listBranches(repositoryRoot: string): Promise<Set<string>> {
  const result = await git(repositoryRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (result.code !== 0) throw gitFailure(result, 'Git branches could not be listed');
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

export async function validateBranchName(repositoryRoot: string, branch: string): Promise<void> {
  if (!branch || branch.length > 200 || branch.startsWith('-')) {
    throw new ApiError(400, 'invalid_branch_name', 'The branch name is not valid.');
  }
  const result = await git(repositoryRoot, ['check-ref-format', '--branch', branch]);
  if (result.code !== 0) {
    throw new ApiError(
      400,
      'invalid_branch_name',
      `"${branch}" is not a valid Git branch name.`,
    );
  }
}

export async function currentBranch(worktreePath: string): Promise<string | null> {
  const result = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length === 0 ? null : value;
}

export async function listWorktreePaths(repositoryRoot: string): Promise<string[]> {
  const result = await git(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) throw gitFailure(result, 'Git worktrees could not be listed');
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)));
}

export async function isBranchCheckedOut(
  repositoryRoot: string,
  branch: string,
): Promise<boolean> {
  const result = await git(repositoryRoot, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) throw gitFailure(result, 'Git worktrees could not be listed');
  return result.stdout
    .split(/\r?\n/)
    .some((line) => line.trim() === `branch refs/heads/${branch}`);
}

export async function countCommitsBetween(
  repositoryRoot: string,
  baseCommit: string,
  headRef: string,
): Promise<number> {
  const result = await git(repositoryRoot, ['rev-list', '--count', `${baseCommit}..${headRef}`]);
  if (result.code !== 0) throw gitFailure(result, 'Git history could not be read');
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

export async function createBranchIfMissing(
  repositoryRoot: string,
  branch: string,
  fromCommit: string,
): Promise<string> {
  const existing = await resolveCommitOrNull(repositoryRoot, `refs/heads/${branch}`);
  if (existing) return existing;
  await validateBranchName(repositoryRoot, branch);
  const result = await git(repositoryRoot, ['branch', branch, fromCommit]);
  if (result.code !== 0) {
    // A concurrent integration may have created the same branch first; never
    // overwrite it, just reuse the existing ref.
    const raced = await resolveCommitOrNull(repositoryRoot, `refs/heads/${branch}`);
    if (raced) return raced;
    throw gitFailure(result, `Git branch "${branch}" could not be created`);
  }
  return requireCommit(repositoryRoot, `refs/heads/${branch}`);
}

/** Lists changes introduced by `headRef` relative to `baseCommit` (repository-relative paths). */
export async function readCommittedChanges(
  repositoryRoot: string,
  baseCommit: string,
  headRef: string,
): Promise<ChangedFile[]> {
  const result = await git(repositoryRoot, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    baseCommit,
    headRef,
  ]);
  if (result.code !== 0) throw gitFailure(result, 'Git changes could not be read');

  const tokens = result.stdout.split('\u0000');
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    const kind = STATUS_MAP[status[0] ?? ''] ?? 'modified';
    if (kind === 'renamed' || kind === 'copied') {
      const previousPath = tokens[index + 1];
      const nextPath = tokens[index + 2];
      index += 2;
      if (previousPath && nextPath) {
        files.push({ path: toPosix(nextPath), previousPath: toPosix(previousPath), status: kind });
      }
      continue;
    }
    const changedPath = tokens[index + 1];
    index += 1;
    if (changedPath) files.push({ path: toPosix(changedPath), previousPath: null, status: kind });
  }
  return files;
}

/** Lists uncommitted and untracked files in a worktree. */
export async function readWorktreeChanges(worktreePath: string): Promise<ChangedFile[]> {
  const result = await git(worktreePath, [
    '-c',
    'core.quotepath=false',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (result.code !== 0) throw gitFailure(result, 'The worktree state could not be read');

  const tokens = result.stdout.split('\u0000');
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const changedPath = entry.slice(3);
    if (code === '??') {
      files.push({ path: toPosix(changedPath), previousPath: null, status: 'untracked' });
      continue;
    }
    if (code.includes('R') || code.includes('C')) {
      const previousPath = tokens[index + 1];
      index += 1;
      if (previousPath) {
        files.push({
          path: toPosix(previousPath),
          previousPath: null,
          status: code.includes('R') ? 'renamed' : 'copied',
        });
        files.push({ path: toPosix(changedPath), previousPath: toPosix(previousPath), status: 'added' });
        continue;
      }
    }
    const kind =
      code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : code.includes('T') ? 'typechange' : 'modified';
    files.push({ path: toPosix(changedPath), previousPath: null, status: kind });
  }
  return files;
}

/** Uses Git's own three-way merge machinery without touching any working tree. */
export async function checkMerge(
  repositoryRoot: string,
  targetRef: string,
  sourceRef: string,
): Promise<MergeCheck> {
  const result = await git(
    repositoryRoot,
    ['merge-tree', '--write-tree', '--name-only', targetRef, sourceRef],
    120_000,
  );
  const lines = result.stdout.split(/\r?\n/);
  const tree = lines[0]?.trim() ?? '';
  if (result.code === 0) {
    return { clean: true, tree: tree.length > 0 ? tree : null, conflicts: [] };
  }
  if (result.code !== 1) {
    throw gitFailure(result, 'Git could not compare the source and target branches');
  }
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim().length === 0) break;
    if (line.startsWith('CONFLICT')) break;
    conflicts.push(toPosix(line.trim()));
  }
  return { clean: false, tree: null, conflicts };
}

export async function createMergeCommit(
  repositoryRoot: string,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  const result = await git(repositoryRoot, args);
  if (result.code !== 0) throw gitFailure(result, 'The integration commit could not be created');
  const commit = result.stdout.trim().split(/\r?\n/)[0] ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new ApiError(502, 'git_integration_failed', 'Git did not return an integration commit.');
  }
  return commit;
}

/**
 * Fast-forwards a checked-out worktree branch. Git itself refuses to run when
 * the worktree is dirty or when the update is not a fast-forward, so local
 * work is never discarded by this operation.
 */
export async function fastForwardWorktree(
  worktreePath: string,
  targetCommit: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await git(worktreePath, ['merge', '--ff-only', '--no-edit', targetCommit]);
  if (result.code === 0) return { ok: true, detail: '' };
  const detail = result.stdout.trim() || result.stderr.trim();
  return { ok: false, detail: detail.split(/\r?\n/).slice(-1)[0] ?? '' };
}

export async function headCommit(worktreePath: string): Promise<string | null> {
  return resolveCommitOrNull(worktreePath, 'HEAD');
}

/** Creates a detached worktree for isolated validation of an exact commit. */
export async function addDetachedWorktree(
  repositoryRoot: string,
  worktreePath: string,
  commit: string,
): Promise<void> {
  const result = await git(repositoryRoot, [
    'worktree',
    'add',
    '--detach',
    worktreePath,
    commit,
  ]);
  if (result.code !== 0) throw gitFailure(result, 'The isolated validation worktree could not be created');
}

/**
 * Compare-and-swap a branch ref. Returns false instead of forcing when the
 * target moved, so concurrent integrations can never overwrite each other.
 */
export async function updateBranchRef(
  repositoryRoot: string,
  branch: string,
  newCommit: string,
  expectedOldCommit: string | null,
): Promise<boolean> {
  await validateBranchName(repositoryRoot, branch);
  const args = ['update-ref', `refs/heads/${branch}`, newCommit];
  if (expectedOldCommit) args.push(expectedOldCommit);
  const result = await git(repositoryRoot, args);
  return result.code === 0;
}

export async function commitParents(repositoryRoot: string, commit: string): Promise<string[]> {
  const result = await git(repositoryRoot, ['rev-list', '--parents', '-n', '1', commit]);
  if (result.code !== 0) throw gitFailure(result, 'The integration commit could not be verified');
  return result.stdout.trim().split(/\s+/).slice(1);
}

export async function isAncestor(
  repositoryRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repositoryRoot, [
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  return result.code === 0;
}
