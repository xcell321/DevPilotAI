import type { WorkspaceMode } from '../lib/types';

type WorkspaceModeChoice = WorkspaceMode | '';

interface TerminalWorkspaceMetaProps {
  workspaceMode: WorkspaceMode | null;
  projectName: string;
  projectPath: string;
  readyWorktrees: number;
  modeChoice: WorkspaceModeChoice;
  onModeChoiceChange: (choice: WorkspaceModeChoice) => void;
}

const MODE_LABELS: Record<WorkspaceMode, string> = {
  shared: 'Shared Folder',
  isolated: 'Isolated Worktrees',
};

function modeNote(workspaceMode: WorkspaceMode | null, readyWorktrees: number): string {
  if (workspaceMode === 'isolated') return `${readyWorktrees} ready worktree(s)`;
  if (workspaceMode === 'shared') return 'All terminals use this folder; edits are not isolated.';
  return 'Choose a mode before adding a CLI; existing terminal paths will not change.';
}

export function TerminalWorkspaceMeta({
  workspaceMode,
  projectName,
  projectPath,
  readyWorktrees,
  modeChoice,
  onModeChoiceChange,
}: TerminalWorkspaceMetaProps) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-1 pb-2 text-[11px]"
      data-testid="workspace-status"
    >
      <p className="min-w-0 text-muted">
        Workspace <span className="text-lineStrong">·</span>{' '}
        <span className="text-ink">
          {workspaceMode ? MODE_LABELS[workspaceMode] : 'Mode not set'}
        </span>
        {' — '}
        <span className="uppercase tracking-wide text-ink">{projectName}</span>
        {' · '}
        <span className="mono" title={projectPath}>
          {projectPath}
        </span>
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted">{modeNote(workspaceMode, readyWorktrees)}</span>
        {!workspaceMode ? (
          <select
            className="input w-auto py-0.5 text-[11px]"
            aria-label="Choose workspace mode for this saved session"
            value={modeChoice}
            onChange={(event) => onModeChoiceChange(event.target.value as WorkspaceModeChoice)}
            data-testid="existing-workspace-mode"
          >
            <option value="">Choose workspace mode...</option>
            <option value="shared">Shared Folder</option>
            <option value="isolated">Isolated Worktrees</option>
          </select>
        ) : null}
      </div>
    </div>
  );
}
