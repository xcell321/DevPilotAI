export interface ToolDefinition {
  id: string;
  displayName: string;
  envVar: string;
  executableNames: string[];
  knownPaths: string[];
  probeArgs: string[] | null;
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  notes: string;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    id: 'claude',
    displayName: 'Claude Code CLI',
    envVar: 'DEVPILOT_CLAUDE_PATH',
    executableNames: ['claude.exe', 'claude.cmd', 'claude.bat', 'claude'],
    knownPaths: [
      '%APPDATA%/npm/claude.cmd',
      '%APPDATA%/npm/node_modules/.bin/claude.cmd',
      '%APPDATA%/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      '~/.local/bin/claude',
    ],
    probeArgs: ['--version'],
    enabled: true,
    defaultOnQuickStart: true,
    launchVerified: true,
    notes:
      'Interactive Claude Code launch verified in P0; the executable is resolved without a machine-specific path.',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    envVar: 'DEVPILOT_OPENCODE_PATH',
    executableNames: ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode'],
    knownPaths: [
      '%APPDATA%/npm/opencode.cmd',
      '%APPDATA%/npm/node_modules/.bin/opencode.cmd',
      '%APPDATA%/npm/node_modules/opencode-ai/bin/opencode.exe',
      '~/.local/bin/opencode',
    ],
    probeArgs: null,
    enabled: false,
    defaultOnQuickStart: false,
    launchVerified: false,
    notes:
      'Executable and PTY launch verified in P0, but the TUI rendered blank. Interactive terminal is not verified yet.',
  },
  {
    id: 'freebuff',
    displayName: 'Freebuff CLI',
    envVar: 'DEVPILOT_FREEBUFF_PATH',
    executableNames: ['freebuff.exe', 'freebuff.cmd', 'freebuff.bat', 'freebuff'],
    knownPaths: [
      '%APPDATA%/npm/freebuff.cmd',
      '%APPDATA%/npm/node_modules/.bin/freebuff.cmd',
      '%USERPROFILE%/.config/manicode/freebuff.exe',
      '~/.local/bin/freebuff',
    ],
    probeArgs: ['--version'],
    enabled: false,
    defaultOnQuickStart: false,
    launchVerified: false,
    notes:
      'Executable and version verified in P0. Interactive behavior is not verified; never launch it automatically.',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    envVar: 'DEVPILOT_ANTIGRAVITY_PATH',
    executableNames: [],
    knownPaths: [],
    probeArgs: null,
    enabled: false,
    defaultOnQuickStart: false,
    launchVerified: false,
    notes:
      'Executable and launch syntax not verified. Disabled until configured manually; no command is guessed.',
  },
];

export function getToolDefinition(toolId: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.id === toolId);
}

export function verifiedProbeArgs(toolId: string): string[] | null {
  return getToolDefinition(toolId)?.probeArgs ?? null;
}
