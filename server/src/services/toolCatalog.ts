export interface ToolDefinition {
  id: string;
  displayName: string;
  envVar: string;
  executableNames: string[];
  knownPaths: string[];
  probeArgs: string[] | null;
  fixedArgs?: string[];
  enabled: boolean;
  defaultOnQuickStart: boolean;
  launchVerified: boolean;
  authGuidance: string;
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
    authGuidance:
      'Run claude in the terminal to authenticate via browser, or set ANTHROPIC_API_KEY.',
    notes:
      'Interactive Claude Code launch verified in P0; the executable is resolved without a machine-specific path.',
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
    enabled: true,
    defaultOnQuickStart: false,
    launchVerified: true,
    authGuidance:
      'Run freebuff in the terminal to sign in and activate your session streak.',
    notes:
      'Interactive Freebuff launch verified. Tested with node-pty (streak active, task prompt responsive).',
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot CLI',
    envVar: 'DEVPILOT_COPILOT_PATH',
    executableNames: ['copilot.exe', 'copilot.cmd', 'copilot.bat', 'copilot'],
    knownPaths: [
      '%LOCALAPPDATA%/Programs/Microsoft VS Code/bin/copilot-shim/copilot.exe',
      '%USERPROFILE%/SCHOOL PURPOSES/Microsoft VS Code/bin/copilot-shim/copilot.exe',
      '~/.local/bin/copilot',
    ],
    probeArgs: ['--version'],
    enabled: true,
    defaultOnQuickStart: false,
    launchVerified: true,
    authGuidance:
      'Authenticate with GitHub via browser/device code (gh auth login or interactive prompt in copilot).',
    notes:
      'Interactive GitHub Copilot CLI launch verified. Tested with node-pty; authenticated via GitHub OAuth.',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity CLI',
    envVar: 'DEVPILOT_ANTIGRAVITY_PATH',
    executableNames: ['agy.exe', 'agy.cmd', 'agy.bat', 'agy'],
    knownPaths: ['%LOCALAPPDATA%/agy/bin/agy.exe', '~/.local/bin/agy'],
    probeArgs: ['--version'],
    enabled: true,
    defaultOnQuickStart: false,
    launchVerified: true,
    authGuidance:
      'Run agy in the terminal to authenticate with your Google account or provide GEMINI_API_KEY.',
    notes:
      'Official agy CLI discovery, version check (1.4.10), and interactive launch verified. Tested with node-pty (Gemini 3.8 Flash).',
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
    probeArgs: ['--version'],
    fixedArgs: [],
    enabled: false,
    defaultOnQuickStart: false,
    launchVerified: true,
    authGuidance:
      'Run opencode auth login or configure providers in ~/.local/share/opencode/auth.json.',
    notes:
      'Interactive launch verified with original full-screen TUI. Tested with node-pty (prompt, keyboard shortcuts, commands, and resize responsive).',
  },
];

export function getToolDefinition(toolId: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.id === toolId);
}

export function verifiedProbeArgs(toolId: string): string[] | null {
  return getToolDefinition(toolId)?.probeArgs ?? null;
}
