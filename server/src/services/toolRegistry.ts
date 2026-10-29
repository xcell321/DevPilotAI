import type { ToolProfile, ToolStatus } from '../../../shared/api-types.cjs';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import { TOOL_DEFINITIONS, getToolDefinition, verifiedProbeArgs } from './toolCatalog';
import { isExecutableFile } from './executable';
import { probeExecutable } from './toolProbe';
import { resolveToolCommand } from './toolDiscovery';

export type { ToolProfile, ToolStatus };

const toolVersionCache = new Map<string, string>();

export function extractVersionFromOutput(output: string): string {
  const line = output.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.slice(0, 100);
}

export function getToolVersion(id: string): string | null {
  return toolVersionCache.get(id) ?? null;
}

export function setToolVersion(id: string, version: string): void {
  toolVersionCache.set(id, version);
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
      display_name = excluded.display_name,
      launch_verified = excluded.launch_verified,
      notes = excluded.notes,
      enabled = CASE
        WHEN excluded.launch_verified = 0 THEN 0
        WHEN tool_profiles.launch_verified = 0 AND excluded.launch_verified = 1 THEN excluded.enabled
        ELSE tool_profiles.enabled
      END,
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
  const def = getToolDefinition(row.id);
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
    authGuidance: def?.authGuidance ?? null,
    version: toolVersionCache.get(row.id) ?? null,
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
  output?: string,
): void {
  if (output && status === 'available') {
    const version = extractVersionFromOutput(output);
    if (version) {
      toolVersionCache.set(id, version);
    }
  }
  db.prepare(
    'UPDATE tool_profiles SET last_status = ?, last_checked_at = ? WHERE id = ?',
  ).run(status, checkedAt, id);
}

export function setToolEnabled(db: Db, id: string, enabled: boolean): ToolProfile {
  const tool = getToolProfile(db, id);
  if (!tool) {
    throw new ApiError(404, 'tool_not_found', 'CLI profile not found.');
  }
  if (enabled && !tool.launchVerified) {
    throw new ApiError(
      409,
      'tool_not_verified',
      `Cannot enable ${tool.displayName}: interactive launch is not verified.`,
    );
  }
  db.prepare('UPDATE tool_profiles SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return getToolProfile(db, id)!;
}

export function warmToolVersions(db: Db): void {
  const tools = listToolProfiles(db);
  void Promise.all(
    tools.map(async (tool) => {
      if (!tool.command || tool.lastStatus !== 'available') return;
      const probeArgs = verifiedProbeArgs(tool.id);
      if (!probeArgs) return;
      try {
        const result = await probeExecutable(tool.command, probeArgs, 5000);
        if (result.status === 'available') {
          updateToolCheck(db, tool.id, result.status, result.checkedAt, result.output);
        }
      } catch {
        // Non-blocking best-effort background warming
      }
    }),
  );
}
