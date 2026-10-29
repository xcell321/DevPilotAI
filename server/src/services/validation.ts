import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ValidationCommandConfig } from '../../../shared/api-types.cjs';
import { ApiError } from '../errors';
import {
  DEFAULT_VALIDATION_TIMEOUT_MS,
  MAX_PROTECTED_PATHS,
  MAX_VALIDATION_COMMANDS,
  MAX_VALIDATION_TIMEOUT_MS,
} from '../limits';
import { killProcessTree, sanitizedEnv } from './processUtils';

const MAX_VALIDATION_NAME_LENGTH = 80;
const MAX_VALIDATION_COMMAND_LENGTH = 512;
const MAX_VALIDATION_ARGS = 64;
const MAX_VALIDATION_ARG_LENGTH = 512;
const MAX_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const MIN_VALIDATION_TIMEOUT_MS = 1_000;

const WINDOWS_SHELL_SHIMS = new Set(['.cmd', '.bat']);

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function validateArgument(value: string): string {
  if (
    value.length > MAX_VALIDATION_ARG_LENGTH ||
    hasControlCharacters(value) ||
    (process.platform === 'win32' && /["'&|<>^%!]/.test(value))
  ) {
    throw new ApiError(
      400,
      'invalid_validation_command',
      'Validation arguments cannot contain control characters or shell metacharacters.',
    );
  }
  return value;
}

function validateCommandPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_VALIDATION_COMMAND_LENGTH ||
    hasControlCharacters(value) ||
    (process.platform === 'win32' && /["'&|<>^%!]/.test(value))
  ) {
    throw new ApiError(
      400,
      'invalid_validation_command',
      'Validation commands must be executable names or absolute paths without shell metacharacters.',
    );
  }
  return value;
}

export function normalizeValidationCommands(input: unknown): ValidationCommandConfig[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'invalid_validation_command', 'Validation commands must be a list.');
  }
  if (input.length > MAX_VALIDATION_COMMANDS) {
    throw new ApiError(
      400,
      'invalid_validation_command',
      `At most ${MAX_VALIDATION_COMMANDS} validation commands can be configured.`,
    );
  }

  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new ApiError(400, 'invalid_validation_command', 'Each validation command must be an object.');
    }
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (
      name.length === 0 ||
      name.length > MAX_VALIDATION_NAME_LENGTH ||
      hasControlCharacters(name)
    ) {
      throw new ApiError(
        400,
        'invalid_validation_command',
        'Each validation command needs a short name.',
      );
    }
    const command = validateCommandPath(
      typeof raw.command === 'string' ? raw.command.trim() : '',
    );
    const args = raw.args === undefined ? [] : raw.args;
    if (!Array.isArray(args) || args.length > MAX_VALIDATION_ARGS) {
      throw new ApiError(
        400,
        'invalid_validation_command',
        'Validation command arguments must be a list of at most 64 strings.',
      );
    }
    const normalizedArgs = args.map((value) => {
      if (typeof value !== 'string') {
        throw new ApiError(400, 'invalid_validation_command', 'Validation arguments must be strings.');
      }
      return validateArgument(value);
    });
    const timeoutMs =
      raw.timeoutMs === undefined
        ? DEFAULT_VALIDATION_TIMEOUT_MS
        : typeof raw.timeoutMs === 'number'
          ? Math.floor(raw.timeoutMs)
          : Number.NaN;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs < MIN_VALIDATION_TIMEOUT_MS ||
      timeoutMs > MAX_VALIDATION_TIMEOUT_MS
    ) {
      throw new ApiError(
        400,
        'invalid_validation_command',
        `Validation timeouts must be between ${MIN_VALIDATION_TIMEOUT_MS} and ${MAX_VALIDATION_TIMEOUT_MS} ms.`,
      );
    }
    return {
      name,
      command,
      args: normalizedArgs,
      required: raw.required === undefined ? true : raw.required === true,
      timeoutMs,
    };
  });
}

export function normalizeProtectedPaths(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new ApiError(400, 'invalid_protected_paths', 'Protected paths must be a list.');
  }
  if (input.length > MAX_PROTECTED_PATHS) {
    throw new ApiError(
      400,
      'invalid_protected_paths',
      `At most ${MAX_PROTECTED_PATHS} protected paths can be configured.`,
    );
  }
  return [
    ...new Set(
      input.map((entry) => {
        if (typeof entry !== 'string') {
          throw new ApiError(400, 'invalid_protected_paths', 'Protected paths must be strings.');
        }
        const candidate = entry.trim().replace(/\\/g, '/').replace(/^\.\//, '');
        if (
          candidate.length === 0 ||
          candidate.length > 512 ||
          candidate.startsWith('/') ||
          /^[a-zA-Z]:/.test(candidate) ||
          candidate.split('/').includes('..') ||
          hasControlCharacters(candidate)
        ) {
          throw new ApiError(
            400,
            'invalid_protected_paths',
            'Protected paths must be repository-relative and cannot escape the repository.',
          );
        }
        return candidate.replace(/\/+$/, '');
      }),
    ),
  ];
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(directory: string, command: string): string[] {
  if (process.platform !== 'win32') return [path.join(directory, command)];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const lower = command.toLowerCase();
  const hasExtension = extensions.some((extension) => lower.endsWith(extension));
  if (hasExtension) return [path.join(directory, command)];
  return extensions.map((extension) => path.join(directory, `${command}${extension}`));
}

/**
 * Resolves a configured validation command to a concrete executable. Only
 * existing files are accepted; Windows `.cmd`/`.bat` shims go through ComSpec
 * with arguments that were already checked for shell metacharacters.
 */
export function resolveValidationCommand(command: string): { file: string; args: string[] } | null {
  let resolved: string | null = null;
  if (path.isAbsolute(command)) {
    resolved = isExecutableFile(command) ? command : null;
  } else if (command === 'node') {
    resolved = process.execPath;
  } else {
    const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '').split(';') : [''];
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!directory) continue;
      for (const candidate of pathCandidates(directory, command)) {
        if (isExecutableFile(candidate)) {
          resolved = candidate;
          break;
        }
        if (process.platform === 'win32' && extensions.length === 0) break;
      }
      if (resolved) break;
    }
  }

  if (!resolved) return null;
  const extension = path.extname(resolved).toLowerCase();
  if (process.platform === 'win32' && WINDOWS_SHELL_SHIMS.has(extension)) {
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', resolved] };
  }
  return { file: resolved, args: [] };
}

export interface ValidationExecutionResult {
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled';
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/**
 * Runs validation commands without elevated privileges and serializes runs per
 * candidate directory so shared build artifacts cannot be corrupted.
 */
export class ValidationExecutor {
  private readonly active = new Map<string, { child: ReturnType<typeof spawn>; cancelled: boolean }>();
  private readonly locks = new Map<string, Promise<void>>();

  isRunning(key: string): boolean {
    return this.active.has(key);
  }

  cancel(key: string): boolean {
    const entry = this.active.get(key);
    if (!entry) return false;
    entry.cancelled = true;
    killProcessTree(entry.child.pid);
    return true;
  }

  runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }

  execute(
    key: string,
    command: ValidationCommandConfig,
    cwd: string,
  ): Promise<ValidationExecutionResult> {
    const invocation = resolveValidationCommand(command.command);
    if (!invocation) {
      return Promise.resolve({
        status: 'failed',
        exitCode: null,
        durationMs: 0,
        output: `The configured executable "${command.command}" was not found or is not executable.`,
      });
    }

    return new Promise((resolve) => {
      const startedAt = Date.now();
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(invocation.file, [...invocation.args, ...command.args], {
          cwd,
          env: sanitizedEnv(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({
          status: 'failed',
          exitCode: null,
          durationMs: Date.now() - startedAt,
          output:
            error instanceof Error
              ? `The validation command could not be started: ${error.message}`
              : 'The validation command could not be started.',
        });
        return;
      }

      const entry = { child, cancelled: false };
      this.active.set(key, entry);
      let output = '';
      let settled = false;
      let exitCode: number | null = null;

      const append = (data: Buffer) => {
        output += data.toString('utf8');
        if (output.length > MAX_VALIDATION_OUTPUT_BYTES) {
          output = output.slice(-MAX_VALIDATION_OUTPUT_BYTES);
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const finish = (status: ValidationExecutionResult['status']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.active.get(key) === entry) this.active.delete(key);
        resolve({
          status,
          exitCode,
          durationMs: Date.now() - startedAt,
          output,
        });
      };

      const timer = setTimeout(() => {
        killProcessTree(child.pid);
        finish('timed_out');
      }, command.timeoutMs);
      timer.unref?.();

      child.on('error', () => finish('failed'));
      child.on('close', (code) => {
        exitCode = code;
        if (entry.cancelled) finish('cancelled');
        else finish(code === 0 ? 'passed' : 'failed');
      });
    });
  }
}
