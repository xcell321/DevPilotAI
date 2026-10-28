import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface ProcessExit {
  exitCode: number;
  signal?: number;
}

export interface OwnedProcess {
  pid: number;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type ProcessLauncher = (spec: SpawnSpec) => OwnedProcess;

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPty;
}

export function createPtyLauncher(): ProcessLauncher {
  const requireFromHere = createRequire(__filename);

  return (spec) => {
    const pty = requireFromHere('node-pty') as PtyModule;
    const child = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    });

    return {
      pid: child.pid,
      onData(listener) {
        const disposable = child.onData(listener);
        return () => disposable.dispose();
      },
      onExit(listener) {
        const disposable = child.onExit((exit) => listener(exit));
        return () => disposable.dispose();
      },
      write(data) {
        child.write(data);
      },
      resize(cols, rows) {
        child.resize(cols, rows);
      },
      kill() {
        child.kill();
      },
    };
  };
}
