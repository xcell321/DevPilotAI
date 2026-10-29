import fs from 'node:fs';
import path from 'node:path';
import type { ProjectPathStatus } from '../../../shared/api-types.cjs';
import { ApiError } from '../errors';
import { MAX_PATH_LENGTH, MAX_PROJECT_NAME_LENGTH } from '../limits';

export type { ProjectPathStatus };

export interface ValidatedProjectPath {
  path: string;
  pathKey: string;
}

const VALIDATION_TIMEOUT_MS = 5000;
const STATUS_TIMEOUT_MS = 750;

const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function invalid(message: string): never {
  throw new ApiError(400, 'invalid_project_path', message);
}

function ensureWindowsShape(candidate: string): void {
  if (candidate.length === 0) invalid('Enter a folder path.');
  if (candidate.length > MAX_PATH_LENGTH) invalid('The folder path is too long.');

  if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
    invalid('Network, device, and UNC paths are not supported. Use a local drive path.');
  }

  for (const character of candidate) {
    if (character.charCodeAt(0) < 32) {
      invalid('The folder path contains invalid characters.');
    }
  }

  if (!/^[A-Za-z]:[\\/]/.test(candidate)) {
    invalid('Enter an absolute local drive path, for example D:\\Projects\\My App.');
  }

  if (candidate.startsWith('~')) {
    invalid('Home-directory shortcuts are not supported. Use the full local drive path.');
  }
}

function ensureNotDriveRoot(normalized: string): void {
  if (/^[A-Za-z]:\\?$/.test(normalized)) {
    invalid('Select a project folder below the drive root, not the drive root itself.');
  }
}

function ensureValidSegments(normalized: string): void {
  const parsed = path.win32.parse(normalized);
  const rest = normalized.slice(parsed.root.length);
  const segments = rest.split('\\').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    invalid('Select a project folder below the drive root, not the drive root itself.');
  }

  for (const segment of segments) {
    if (/[<>:"|?*]/.test(segment)) {
      invalid('The folder path contains characters that Windows does not allow.');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      invalid('Folder names cannot end with a dot or space.');
    }

    const baseName = segment.split('.')[0]?.toUpperCase() ?? '';
    if (RESERVED_NAMES.has(baseName)) {
      invalid('The folder path contains a Windows reserved device name.');
    }
  }
}

function normalizeShape(input: string): string {
  const trimmed = input.trim();
  ensureWindowsShape(trimmed);

  const withBackslashes = trimmed.replace(/\//g, '\\');
  const normalized = path.win32.normalize(withBackslashes);

  ensureNotDriveRoot(normalized);
  ensureValidSegments(normalized);
  return normalized;
}

function realpathNative(candidate: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.realpath.native(candidate, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ApiError(400, 'path_unavailable', `${label} did not respond in time.`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mapFileSystemError(error: unknown): ApiError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  switch (code) {
    case 'ENOENT':
      return new ApiError(400, 'path_not_found', 'The selected folder does not exist.');
    case 'ENOTDIR':
      return new ApiError(400, 'path_not_directory', 'The selected path is not a folder.');
    case 'EACCES':
    case 'EPERM':
      return new ApiError(
        400,
        'path_inaccessible',
        'The selected folder is not accessible with the current Windows account.',
      );
    case 'ENAMETOOLONG':
      return new ApiError(400, 'invalid_project_path', 'The folder path is too long.');
    default:
      return new ApiError(400, 'path_unavailable', 'The selected folder could not be checked.');
  }
}

export async function validateProjectPath(input: string): Promise<ValidatedProjectPath> {
  const normalized = normalizeShape(input);

  try {
    return await withTimeout(
      (async () => {
        const canonical = path.win32.normalize(await realpathNative(normalized));

        ensureWindowsShape(canonical);
        ensureNotDriveRoot(canonical);
        ensureValidSegments(canonical);

        const stats = await fs.promises.stat(canonical);
        if (!stats.isDirectory()) {
          throw new ApiError(400, 'path_not_directory', 'The selected path is not a folder.');
        }

        await fs.promises.access(canonical, fs.constants.R_OK);

        return { path: canonical, pathKey: canonical.toLowerCase() };
      })(),
      VALIDATION_TIMEOUT_MS,
      'The selected folder',
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw mapFileSystemError(error);
  }
}

export function deriveProjectName(canonicalPath: string): string {
  return (path.win32.basename(canonicalPath) || 'Project').slice(0, MAX_PROJECT_NAME_LENGTH);
}

async function checkStoredPath(candidate: string): Promise<ProjectPathStatus> {
  try {
    const stats = await fs.promises.stat(candidate);
    if (!stats.isDirectory()) return 'inaccessible';
    await fs.promises.access(candidate, fs.constants.R_OK);
    return 'ok';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
    return 'inaccessible';
  }
}

export async function getProjectPathStatus(
  projectPath: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<ProjectPathStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      checkStoredPath(projectPath),
      new Promise<ProjectPathStatus>((resolve) => {
        timer = setTimeout(() => resolve('inaccessible'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
