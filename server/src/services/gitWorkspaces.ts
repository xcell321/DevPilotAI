import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ApiError } from '../errors';
import { killProcessTree, sanitizedEnv } from './processUtils';

const GIT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const WORKTREES_DIRECTORY_NAME = 'worktrees';

export interface GitRepositorySnapshot {
  repositoryRoot: string;
  baseCommit: string;
  projectRelativePath: string;
}

export interface GitWorkspacePaths {
  worktreePath: string;
  workingDirectory: string;
}

const AGENT_BRANCH_PREFIX = 'devpilot';

export interface GitCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a Git command and resolves with its structured result instead of throwing
 * on a non-zero exit, so callers can inspect machine-readable output.
 */
export function runGitCommand(
  cwd: string,
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', cwd, ...args], {
        cwd: process.cwd(),
        env: { ...sanitizedEnv(), ...options.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      reject(new ApiError(503, 'git_unavailable', 'Git could not be started.'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const maxOutputBytes = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES;

    const finish = (error: ApiError | null, result?: GitCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };

    timer = setTimeout(() => {
      killProcessTree(child.pid);
      finish(new ApiError(504, 'git_timeout', 'Git workspace setup timed out.'));
    }, options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS);

    const collect = (target: 'stdout' | 'stderr', data: Buffer) => {
      if (settled) return;
      outputBytes += data.length;
      if (outputBytes > maxOutputBytes) {
        killProcessTree(child.pid);
        finish(new ApiError(502, 'git_output_too_large', 'Git returned too much workspace data.'));
        return;
      }
      if (target === 'stdout') stdout += data.toString('utf8');
      else stderr += data.toString('utf8');
    };

    child.stdout?.on('data', (data: Buffer) => collect('stdout', data));
    child.stderr?.on('data', (data: Buffer) => collect('stderr', data));
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      finish(
        new ApiError(
          code === 'ENOENT' ? 503 : 409,
          code === 'ENOENT' ? 'git_unavailable' : 'git_command_failed',
          code === 'ENOENT'
            ? 'Git is not installed or is not available on PATH.'
            : 'Git could not complete the workspace operation.',
        ),
      );
    });
    child.on('close', (code) => {
      finish(null, { code: code ?? 1, stdout, stderr });
    });
  });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args);
  if (result.code !== 0) {
    const detail = result.stderr
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-2)
      .join(' | ');
    throw new ApiError(
      409,
      'git_command_failed',
      detail
        ? `Git could not complete the workspace operation: ${detail}`
        : 'Git could not complete the workspace operation.',
    );
  }
  return result.stdout.trim();
}

function isWithinDirectory(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export async function inspectGitRepository(projectPath: string): Promise<GitRepositorySnapshot> {
  let repositoryRoot: string;
  try {
    repositoryRoot = path.resolve(
      await runGit(projectPath, ['rev-parse', '--show-toplevel']),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'git_unavailable') throw error;
    throw new ApiError(
      409,
      'project_not_git',
      'Multiple CLI agents require the project to be inside a Git repository.',
    );
  }

  const projectRelativePath = path.relative(repositoryRoot, path.resolve(projectPath));
  if (!isWithinDirectory(repositoryRoot, path.resolve(projectPath))) {
    throw new ApiError(
      409,
      'project_path_outside_repository',
      'The project path is outside its Git repository.',
    );
  }

  let baseCommit: string;
  try {
    baseCommit = await runGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'git_unavailable') throw error;
    throw new ApiError(
      409,
      'git_repository_unborn',
      'The Git repository needs a commit before isolated CLI workspaces can be created.',
    );
  }

  const status = await runGit(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status) {
    throw new ApiError(
      409,
      'project_git_dirty',
      'Commit or manually preserve all tracked and untracked changes before starting multiple CLI agents.',
    );
  }

  const submodules = await runGit(repositoryRoot, ['submodule', 'status']);
  if (submodules) {
    throw new ApiError(
      409,
      'git_submodules_unsupported',
      'Projects with Git submodules are not supported for isolated CLI workspaces yet.',
    );
  }

  return { repositoryRoot, baseCommit, projectRelativePath };
}

export function getGitWorkspacePaths(
  runtimeDir: string,
  snapshot: GitRepositorySnapshot,
  sessionId: string,
  terminalId: string,
): GitWorkspacePaths {
  // Keep the key short: Git for Windows rejects worktree paths near PATH_MAX
  // with a cryptic "$GIT_DIR too big" error.
  const repositoryKey = crypto
    .createHash('sha256')
    .update(path.resolve(snapshot.repositoryRoot).toLowerCase())
    .digest('hex')
    .slice(0, 16);
  const worktreePath = path.join(
    runtimeDir,
    WORKTREES_DIRECTORY_NAME,
    repositoryKey,
    sessionId,
    terminalId,
  );
  const workingDirectory = path.resolve(worktreePath, snapshot.projectRelativePath);
  if (!isWithinDirectory(worktreePath, workingDirectory)) {
    throw new ApiError(
      409,
      'project_path_outside_repository',
      'The project path is outside its Git repository.',
    );
  }
  if (process.platform === 'win32' && workingDirectory.length > 200) {
    throw new ApiError(
      409,
      'workspace_path_too_long',
      'The isolated worktree path is too long for Git on Windows. Set DEVPILOT_RUNTIME_DIR to a shorter folder or move the project closer to the drive root.',
    );
  }
  return { worktreePath, workingDirectory };
}

export function getGitBranchName(sessionId: string, terminalId: string): string {
  return `${AGENT_BRANCH_PREFIX}/${sessionId}/${terminalId}`;
}

export async function createGitWorktree(
  snapshot: GitRepositorySnapshot,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  if (fs.existsSync(worktreePath)) {
    throw new ApiError(409, 'git_workspace_path_exists', 'The isolated workspace path already exists.');
  }
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await runGit(snapshot.repositoryRoot, [
    'worktree',
    'add',
    '-b',
    branchName,
    worktreePath,
    snapshot.baseCommit,
  ]);
  if (!fs.statSync(worktreePath).isDirectory()) {
    throw new ApiError(409, 'git_workspace_invalid', 'Git did not create an isolated workspace directory.');
  }
}

export async function removeGitWorktree(
  repositoryRoot: string,
  worktreePath: string,
): Promise<void> {
  if (!fs.existsSync(worktreePath)) return;
  const listed = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain']);
  const target = path.resolve(worktreePath).toLowerCase();
  const isRegisteredWorktree = listed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => path.resolve(line.slice('worktree '.length)).toLowerCase() === target);
  if (!isRegisteredWorktree) return;
  await runGit(repositoryRoot, ['worktree', 'remove', '--force', worktreePath]);
}

export async function validateGitWorkspace(
  worktreePath: string,
  workingDirectory: string,
): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(workingDirectory);
  } catch {
    throw new ApiError(409, 'git_workspace_unavailable', 'The isolated workspace directory is unavailable.');
  }
  if (
    !stats.isDirectory() ||
    !isWithinDirectory(path.resolve(worktreePath), path.resolve(workingDirectory))
  ) {
    throw new ApiError(409, 'git_workspace_unavailable', 'The isolated workspace directory is invalid.');
  }

  let actualRoot: string;
  try {
    actualRoot = path.resolve(await runGit(worktreePath, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new ApiError(409, 'git_workspace_unavailable', 'The isolated Git worktree is no longer available.');
  }
  if (actualRoot.toLowerCase() !== path.resolve(worktreePath).toLowerCase()) {
    throw new ApiError(409, 'git_workspace_invalid', 'The isolated workspace no longer matches its Git worktree.');
  }
}
