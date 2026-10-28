const VERIFIED_PROBE_ARGS: Record<string, string[] | null> = {
  claude: ['--version'],
  freebuff: ['--version'],
  opencode: null,
  antigravity: null,
};

export function verifiedProbeArgs(toolId: string): string[] | null {
  return VERIFIED_PROBE_ARGS[toolId] ?? null;
}
