import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { inspectExecutable } from './executable';
import { killProcessTree, sanitizedEnv } from './processUtils';

export type ProbeStatus = 'available' | 'missing' | 'unknown';

export interface ProbeResult {
  status: ProbeStatus;
  output: string;
  checkedAt: string;
}

interface ProbeSpec {
  file: string;
  args: string[];
  verbatim?: boolean;
}

const PROBE_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 16384;
const PROBE_OUTPUT_DISPLAY_LIMIT = 400;

function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildProbeSpec(command: string, args: string[]): ProbeSpec {
  const extension = path.extname(command).toLowerCase();

  if (extension === '.cmd' || extension === '.bat') {
    const commandLine = [quoteForCmd(command), ...args.map(quoteForCmd)].join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      verbatim: true,
    };
  }

  if (extension === '.ps1') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        command,
        ...args,
      ],
    };
  }

  return { file: command, args };
}

function finish(
  resolve: (result: ProbeResult) => void,
  status: ProbeStatus,
  output: string,
): void {
  resolve({
    status,
    output: output.trim().slice(0, PROBE_OUTPUT_DISPLAY_LIMIT),
    checkedAt: new Date().toISOString(),
  });
}

export function probeExecutable(
  command: string,
  args: string[],
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const inspection = inspectExecutable(command);
    if (!inspection.absolute) {
      finish(resolve, 'missing', '');
      return;
    }
    if (!inspection.exists) {
      finish(resolve, inspection.errorCode === 'ENOENT' ? 'missing' : 'unknown', '');
      return;
    }
    if (!inspection.isFile) {
      finish(resolve, 'missing', '');
      return;
    }
    if (!inspection.executable) {
      finish(resolve, 'unknown', '');
      return;
    }

    const spec = buildProbeSpec(command, args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: os.tmpdir(),
        env: sanitizedEnv(),
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim ?? false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(resolve, 'unknown', '');
      return;
    }

    let output = '';
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;
    let timer: NodeJS.Timeout | null = null;

    const finishOnce = (status: ProbeStatus) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finish(resolve, status, output);
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      finishOnce('unknown');
    }, timeoutMs);

    const collect = (data: Buffer) => {
      if (settled) return;
      if (output.length >= MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        killProcessTree(child.pid);
        finishOnce('unknown');
        return;
      }
      output += data.toString('utf8').slice(0, MAX_OUTPUT_BYTES - output.length);
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    child.on('error', (error) => {
      finishOnce((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown');
    });

    child.on('close', (code) => {
      if (timedOut || outputExceeded) {
        finishOnce('unknown');
        return;
      }
      finishOnce(code === 0 ? 'available' : 'unknown');
    });
  });
}
