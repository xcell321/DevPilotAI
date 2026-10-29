import { spawn } from 'node:child_process';
import os from 'node:os';
import { ApiError } from '../errors';
import { killProcessTree, sanitizedEnv } from './processUtils';

const PICKER_TIMEOUT_MS = 120000;
const MAX_STDERR_BYTES = 8192;

const PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a project folder for DevPilot AI'
$dialog.ShowNewFolderButton = $false
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  if ([string]::IsNullOrWhiteSpace($dialog.SelectedPath)) {
    exit 4
  }
  [Console]::Out.WriteLine($dialog.SelectedPath)
  exit 0
}
exit 3
`.trim();

let pickerInFlight = false;

export function pickFolder(): Promise<string> {
  if (pickerInFlight) {
    return Promise.reject(
      new ApiError(409, 'folder_picker_busy', 'The folder picker is already open.'),
    );
  }

  pickerInFlight = true;

  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-STA', '-Command', PICKER_SCRIPT],
        {
          cwd: os.tmpdir(),
          env: sanitizedEnv(),
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch {
      pickerInFlight = false;
      reject(
        new ApiError(
          500,
          'folder_picker_failed',
          'Could not open the Windows folder dialog. Enter the path manually.',
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (error: ApiError | null, value?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      pickerInFlight = false;
      if (error) reject(error);
      else resolve(value ?? '');
    };

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
      finish(
        new ApiError(
          504,
          'folder_picker_timeout',
          'The folder dialog timed out. Enter the path manually.',
        ),
      );
    }, PICKER_TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < MAX_STDERR_BYTES) stdout += data.toString('utf8');
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += data.toString('utf8');
    });

    child.on('error', () => {
      finish(
        new ApiError(
          500,
          'folder_picker_failed',
          'Could not open the Windows folder dialog. Enter the path manually.',
        ),
      );
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish(
          new ApiError(
            504,
            'folder_picker_timeout',
            'The folder dialog timed out. Enter the path manually.',
          ),
        );
        return;
      }

      if (code === 3) {
        finish(new ApiError(409, 'folder_picker_cancelled', 'Folder selection was cancelled.'));
        return;
      }

      const selected = stdout.trim();
      if (code === 0 && selected) {
        finish(null, selected);
        return;
      }

      console.error(
        `Folder picker failed with exit code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`,
      );
      finish(
        new ApiError(
          500,
          'folder_picker_failed',
          'Could not open the Windows folder dialog. Enter the path manually.',
        ),
      );
    });
  });
}
