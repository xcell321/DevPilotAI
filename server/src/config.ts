import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  resolveRuntimeDir,
  runtimeFileFor,
} from '../../shared/runtime-paths.cjs';
import { DEFAULT_MAX_TERMINALS_PER_SESSION } from './limits';

const repoRoot = path.resolve(__dirname, '..', '..');

export interface AppConfig {
  repoRoot: string;
  host: string;
  port: number;
  dbPath: string;
  webDist: string;
  runtimeDir: string;
  tokenFile: string;
  maxTerminals: number;
  maxTerminalsPerSession: number;
  version: string;
}

const envSchema = z.object({
  DEVPILOT_HOST: z.string().min(1).default('127.0.0.1'),
  DEVPILOT_PORT: z.coerce.number().int().min(0).max(65535).default(0),
  DEVPILOT_DB_PATH: z.string().min(1).optional(),
  DEVPILOT_WEB_DIST: z.string().min(1).optional(),
  DEVPILOT_RUNTIME_DIR: z.string().min(1).optional(),
  DEVPILOT_MAX_TERMINALS: z.coerce.number().int().min(1).max(32).default(8),
  DEVPILOT_MAX_TERMINALS_PER_SESSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULT_MAX_TERMINALS_PER_SESSION),
});

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function readServerVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
  } catch {
    // .env is optional.
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid DevPilot environment configuration: ${details}`);
  }

  const value = parsed.data;
  if (!isLoopbackHost(value.DEVPILOT_HOST)) {
    throw new Error(
      'Invalid DevPilot environment configuration: DEVPILOT_HOST must be a loopback address.',
    );
  }

  const dbPath = value.DEVPILOT_DB_PATH
    ? path.resolve(repoRoot, value.DEVPILOT_DB_PATH)
    : path.join(repoRoot, 'data', 'devpilot.db');
  const runtimeEnv = {
    ...env,
    DEVPILOT_RUNTIME_DIR: value.DEVPILOT_RUNTIME_DIR,
  };
  const runtimeDir = resolveRuntimeDir(repoRoot, runtimeEnv);
  const maxTerminals = value.DEVPILOT_MAX_TERMINALS;
  const maxTerminalsPerSession = Math.min(
    value.DEVPILOT_MAX_TERMINALS_PER_SESSION,
    maxTerminals,
  );

  return {
    repoRoot,
    host: value.DEVPILOT_HOST,
    port: value.DEVPILOT_PORT,
    dbPath,
    webDist: value.DEVPILOT_WEB_DIST
      ? path.resolve(repoRoot, value.DEVPILOT_WEB_DIST)
      : path.join(repoRoot, 'apps', 'web', 'dist'),
    runtimeDir,
    tokenFile: runtimeFileFor(repoRoot, runtimeEnv),
    maxTerminals,
    maxTerminalsPerSession,
    version: readServerVersion(),
  };
}
