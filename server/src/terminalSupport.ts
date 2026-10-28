import { createRequire } from 'node:module';

const requireFromHere = createRequire(__filename);

export interface TerminalSupport {
  status: 'available' | 'unavailable';
  detail: string;
}

export function detectTerminalSupport(): TerminalSupport {
  try {
    requireFromHere('node-pty');
    const packageJson = requireFromHere('node-pty/package.json') as { version?: string };
    return {
      status: 'available',
      detail: `node-pty ${packageJson.version ?? 'unknown'} loaded; no process was spawned`,
    };
  } catch {
    return {
      status: 'unavailable',
      detail: 'node-pty could not be loaded on this machine',
    };
  }
}
