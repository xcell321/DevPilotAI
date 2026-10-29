import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import type { Db } from '../src/db/types';
import { resolveToolCommand } from '../src/services/toolDiscovery';
import { getToolProfile, seedToolProfiles } from '../src/services/toolRegistry';

let tempDir: string;
let db: Db;

function writeFile(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  return file;
}

function isolatedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: '',
    APPDATA: path.join(tempDir, 'empty-appdata'),
    USERPROFILE: path.join(tempDir, 'empty-home'),
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-discovery-'));
  db = openDatabase(path.join(tempDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('tool executable discovery', () => {
  it('prefers an explicit configured path and never silently substitutes it', () => {
    const known = writeFile(
      path.join(
        tempDir,
        'appdata',
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
    );
    const pathShim = writeFile(path.join(tempDir, 'path tools', 'claude.exe'));
    const configured = path.join(tempDir, 'missing tools', 'claude.exe');

    const result = resolveToolCommand('claude', {
      DEVPILOT_CLAUDE_PATH: configured,
      PATH: path.dirname(pathShim),
      APPDATA: path.join(tempDir, 'appdata'),
      USERPROFILE: path.join(tempDir, 'home'),
    });

    expect(result).toEqual({ command: configured, source: 'configured' });
    expect(known).not.toBe(configured);
  });

  it('finds an executable on PATH even when the installation path has spaces', () => {
    const executable = writeFile(path.join(tempDir, 'Program Files With Spaces', 'claude.exe'));

    const result = resolveToolCommand(
      'claude',
      isolatedEnv({ PATH: path.dirname(executable) }),
    );

    expect(result).toEqual({ command: executable, source: 'path' });
  });

  it('finds the known npm global installation location', () => {
    const executable = writeFile(
      path.join(
        tempDir,
        'appdata',
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
    );

    const result = resolveToolCommand(
      'claude',
      isolatedEnv({ APPDATA: path.join(tempDir, 'appdata') }),
    );

    expect(result).toEqual({ command: executable, source: 'known-location' });
  });

  it('finds the GitHub Copilot CLI on PATH', () => {
    const executable = writeFile(path.join(tempDir, 'bin', 'copilot.exe'));
    const result = resolveToolCommand(
      'copilot',
      isolatedEnv({ PATH: path.dirname(executable) }),
    );

    expect(result).toEqual({ command: executable, source: 'path' });
  });

  it('returns no command when nothing is configured or installed', () => {
    const result = resolveToolCommand('freebuff', isolatedEnv());

    expect(result).toEqual({ command: '', source: 'missing' });
  });

  it('finds the official Antigravity CLI installation location', () => {
    const executable = writeFile(path.join(tempDir, 'localappdata', 'agy', 'bin', 'agy.exe'));

    const result = resolveToolCommand(
      'antigravity',
      isolatedEnv({ LOCALAPPDATA: path.join(tempDir, 'localappdata') }),
    );

    expect(result).toEqual({ command: executable, source: 'known-location' });
  });

  it('does not use Windows-only installation locations on POSIX', () => {
    writeFile(
      path.join(
        tempDir,
        'appdata',
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe',
      ),
    );

    const result = resolveToolCommand(
      'claude',
      isolatedEnv({ APPDATA: path.join(tempDir, 'appdata') }),
      'linux',
    );

    expect(result).toEqual({ command: '', source: 'missing' });
  });
});

describe('seeded tool profiles', () => {
  it('keeps an invalid explicit command visible and marks it missing', () => {
    const configured = path.join(tempDir, 'not installed', 'claude & calc.exe');
    const env = isolatedEnv({ DEVPILOT_CLAUDE_PATH: configured });

    seedToolProfiles(db, env);
    const claude = getToolProfile(db, 'claude');

    expect(claude?.command).toBe(configured);
    expect(claude?.lastStatus).toBe('missing');
    expect(claude?.lastCheckedAt).toBeNull();
    expect(claude?.launchable).toBe(false);
    expect(claude?.launchReason).toContain('not found');
  });

  it('updates commands on restart while preserving user enabled state', () => {
    const first = writeFile(path.join(tempDir, 'first', 'claude.exe'));
    const second = writeFile(path.join(tempDir, 'second', 'claude.exe'));

    seedToolProfiles(db, isolatedEnv({ DEVPILOT_CLAUDE_PATH: first }));
    db.prepare("UPDATE tool_profiles SET enabled = 0 WHERE id = 'claude'").run();
    seedToolProfiles(db, isolatedEnv({ DEVPILOT_CLAUDE_PATH: second }));

    const claude = getToolProfile(db, 'claude');
    expect(claude?.command).toBe(second);
    expect(claude?.lastStatus).toBe('available');
    expect(claude?.lastCheckedAt).toBeNull();
    expect(claude?.enabled).toBe(false);
  });

  it('does not overwrite probe history when the command is unchanged', () => {
    const executable = writeFile(path.join(tempDir, 'stable', 'claude.exe'));
    const checkedAt = '2026-01-01T00:00:00.000Z';
    const env = isolatedEnv({ DEVPILOT_CLAUDE_PATH: executable });

    seedToolProfiles(db, env);
    db.prepare(
      "UPDATE tool_profiles SET last_status = 'unknown', last_checked_at = ? WHERE id = 'claude'",
    ).run(checkedAt);
    seedToolProfiles(db, env);

    const claude = getToolProfile(db, 'claude');
    expect(claude?.command).toBe(executable);
    expect(claude?.lastStatus).toBe('unknown');
    expect(claude?.lastCheckedAt).toBe(checkedAt);
  });

  it('preserves manually configured commands across restarts', () => {
    const discovered = writeFile(path.join(tempDir, 'discovered', 'claude.exe'));
    const manual = path.join(tempDir, 'manual', 'claude.exe');
    const checkedAt = '2026-01-02T00:00:00.000Z';

    seedToolProfiles(db, isolatedEnv({ DEVPILOT_CLAUDE_PATH: discovered }));
    db.prepare(
      `UPDATE tool_profiles
       SET command = ?, command_source = 'manual', last_status = 'available', last_checked_at = ?
       WHERE id = 'claude'`,
    ).run(manual, checkedAt);
    seedToolProfiles(db, isolatedEnv({ DEVPILOT_CLAUDE_PATH: discovered }));

    const claude = getToolProfile(db, 'claude');
    expect(claude?.command).toBe(manual);
    expect(claude?.lastStatus).toBe('available');
    expect(claude?.lastCheckedAt).toBe(checkedAt);
  });
});
