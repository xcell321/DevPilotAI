import type { Db } from '../db/types';
import { TOOL_DEFINITIONS } from './toolCatalog';
import { isExecutableFile, resolveToolCommand } from './toolDiscovery';

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
  commandSource: 'configured' | 'discovered' | 'missing';
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  status: ToolStatus;
  notes: string;
}

function detectionStatus(command: string): ToolStatus {
  if (!command) return 'unverified';
  return isExecutableFile(command) ? 'available' : 'missing';
}

function buildSeedProfiles(env: NodeJS.ProcessEnv): SeedProfile[] {
  return TOOL_DEFINITIONS.map((tool) => {
    const resolved = resolveToolCommand(tool.id, env);
    const commandSource =
      resolved.source === 'configured' || resolved.source === 'missing'
        ? resolved.source
        : 'discovered';
    return {
      id: tool.id,
      displayName: tool.displayName,
      command: resolved.command,
      commandSource,
      enabled: tool.enabled,
      defaultOnQuickStart: tool.defaultOnQuickStart,
      launchVerified: tool.launchVerified,
      status: detectionStatus(resolved.command),
      notes: tool.notes,
    };
  });
}

export function seedToolProfiles(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  const insert = db.prepare(`
    INSERT INTO tool_profiles (
      id,
      display_name,
      command,
      command_source,
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
      @commandSource,
      '[]',
      @enabled,
      @defaultOnQuickStart,
      @launchVerified,
      @status,
      NULL,
      @notes
    )
    ON CONFLICT(id) DO UPDATE SET
      command = CASE
        WHEN tool_profiles.command_source = 'manual' THEN tool_profiles.command
        ELSE excluded.command
      END,
      command_source = CASE
        WHEN tool_profiles.command_source = 'manual' THEN tool_profiles.command_source
        ELSE excluded.command_source
      END,
      last_status = CASE
        WHEN tool_profiles.command_source = 'manual' THEN tool_profiles.last_status
        WHEN tool_profiles.command = excluded.command THEN tool_profiles.last_status
        ELSE excluded.last_status
      END,
      last_checked_at = CASE
        WHEN tool_profiles.command_source = 'manual' THEN tool_profiles.last_checked_at
        WHEN tool_profiles.command = excluded.command THEN tool_profiles.last_checked_at
        ELSE NULL
      END
  `);

  const seed = db.transaction((profiles: SeedProfile[]) => {
    for (const profile of profiles) {
      insert.run({
        ...profile,
        enabled: profile.enabled ? 1 : 0,
        defaultOnQuickStart: profile.defaultOnQuickStart ? 1 : 0,
        launchVerified: profile.launchVerified ? 1 : 0,
      });
    }
  });

  seed(buildSeedProfiles(env));
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
