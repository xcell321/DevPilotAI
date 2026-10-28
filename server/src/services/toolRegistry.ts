import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/types';

export type ToolStatus = 'available' | 'missing' | 'unknown' | 'unverified';

export interface ToolProfile {
  id: string;
  displayName: string;
  command: string;
  fixedArgs: string[];
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  launchable: boolean;
  launchReason: string | null;
  lastStatus: ToolStatus;
  lastCheckedAt: string | null;
  notes: string | null;
}

interface ToolProfileRow {
  id: string;
  display_name: string;
  command: string;
  fixed_args_json: string;
  enabled: number;
  default_on_quick_start: number;
  launch_verified: number;
  last_status: ToolStatus;
  last_checked_at: string | null;
  notes: string | null;
}

interface SeedProfile {
  id: string;
  displayName: string;
  command: string;
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  status: ToolStatus;
  notes: string;
}

const npmGlobalModules = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules');
const userProfile = process.env.USERPROFILE ?? '';

function detectionStatus(command: string): ToolStatus {
  if (!command) return 'unverified';
  return fs.existsSync(command) ? 'available' : 'missing';
}

function buildSeedProfiles(): SeedProfile[] {
  const claudeCommand = path.join(
    npmGlobalModules,
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  const opencodeCommand = path.join(npmGlobalModules, 'opencode-ai', 'bin', 'opencode.exe');
  const freebuffCommand = path.join(userProfile, '.config', 'manicode', 'freebuff.exe');

  return [
    {
      id: 'claude',
      displayName: 'Claude Code CLI',
      command: claudeCommand,
      enabled: true,
      defaultOnQuickStart: true,
      launchVerified: true,
      status: detectionStatus(claudeCommand),
      notes: 'Launch command verified interactively in P0 on this machine.',
    },
    {
      id: 'opencode',
      displayName: 'OpenCode CLI',
      command: opencodeCommand,
      enabled: false,
      defaultOnQuickStart: false,
      launchVerified: false,
      status: detectionStatus(opencodeCommand),
      notes:
        'Executable and PTY launch verified in P0, but the TUI rendered blank. Interactive terminal is not verified yet.',
    },
    {
      id: 'freebuff',
      displayName: 'Freebuff CLI',
      command: freebuffCommand,
      enabled: false,
      defaultOnQuickStart: false,
      launchVerified: false,
      status: detectionStatus(freebuffCommand),
      notes:
        'Executable and version verified in P0. Interactive behavior is not verified; never launch it automatically.',
    },
    {
      id: 'antigravity',
      displayName: 'Antigravity',
      command: '',
      enabled: false,
      defaultOnQuickStart: false,
      launchVerified: false,
      status: 'unverified',
      notes:
        'Executable and launch syntax not verified. Disabled until configured manually; no command is guessed.',
    },
  ];
}

export function seedToolProfiles(db: Db): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO tool_profiles (
      id,
      display_name,
      command,
      fixed_args_json,
      enabled,
      default_on_quick_start,
      launch_verified,
      last_status,
      last_checked_at,
      notes
    ) VALUES (
      @id,
      @displayName,
      @command,
      '[]',
      @enabled,
      @defaultOnQuickStart,
      @launchVerified,
      @status,
      @checkedAt,
      @notes
    )
  `);

  const checkedAt = new Date().toISOString();
  const seed = db.transaction((profiles: SeedProfile[]) => {
    for (const profile of profiles) {
      insert.run({
        ...profile,
        enabled: profile.enabled ? 1 : 0,
        defaultOnQuickStart: profile.defaultOnQuickStart ? 1 : 0,
        launchVerified: profile.launchVerified ? 1 : 0,
        checkedAt,
      });
    }
  });

  seed(buildSeedProfiles());
}

function parseFixedArgs(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Invalid legacy value; expose an empty argument list.
  }
  return [];
}

function launchReasonFor(row: ToolProfileRow): string | null {
  if (row.enabled !== 1) return 'Disabled in the CLI registry.';
  if (row.launch_verified !== 1) {
    return 'Interactive launch is not verified for this profile.';
  }
  if (!row.command) return 'No executable is configured.';
  if (row.last_status === 'missing') return 'The configured executable was not found.';
  if (row.last_status === 'unverified') return 'Launch verification is pending.';
  return null;
}

function mapToolRow(row: ToolProfileRow): ToolProfile {
  const launchReason = launchReasonFor(row);
  return {
    id: row.id,
    displayName: row.display_name,
    command: row.command,
    fixedArgs: parseFixedArgs(row.fixed_args_json),
    enabled: row.enabled === 1,
    defaultOnQuickStart: row.default_on_quick_start === 1,
    launchVerified: row.launch_verified === 1,
    launchable: launchReason === null,
    launchReason,
    lastStatus: row.last_status,
    lastCheckedAt: row.last_checked_at,
    notes: row.notes,
  };
}

export function listToolProfiles(db: Db): ToolProfile[] {
  const rows = db
    .prepare(
      `SELECT id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
              launch_verified, last_status, last_checked_at, notes
       FROM tool_profiles
       ORDER BY id`,
    )
    .all() as ToolProfileRow[];

  return rows.map(mapToolRow);
}

export function getToolProfile(db: Db, id: string): ToolProfile | undefined {
  const row = db
    .prepare(
      `SELECT id, display_name, command, fixed_args_json, enabled, default_on_quick_start,
              launch_verified, last_status, last_checked_at, notes
       FROM tool_profiles
       WHERE id = ?`,
    )
    .get(id) as ToolProfileRow | undefined;

  return row ? mapToolRow(row) : undefined;
}

export function updateToolCheck(
  db: Db,
  id: string,
  status: ToolStatus,
  checkedAt: string,
): void {
  db.prepare(
    'UPDATE tool_profiles SET last_status = ?, last_checked_at = ? WHERE id = ?',
  ).run(status, checkedAt, id);
}
