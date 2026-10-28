import { spawnSync } from 'node:child_process';

const ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'USERNAME',
  'USERDOMAIN',
  'SESSIONNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CONFIG_DIR',
];

export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!key.toUpperCase().startsWith('DEVPILOT')) env[key] = value;
  }
  return env;
}

export function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    sanitizedEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }),
  )) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
}
