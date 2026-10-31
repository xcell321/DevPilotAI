import { useState } from 'react';
import { apiDelete } from '../lib/api';
import type { WorkspaceMode } from '../lib/types';
import { ConfirmationModal } from './ConfirmationModal';

type WorkspaceModeChoice = WorkspaceMode | '';

interface TerminalWorkspaceMetaProps {
  workspaceMode: WorkspaceMode | null;
  projectName: string;
  projectPath: string;
  projectId: string;
  readyWorktrees: number;
  modeChoice: WorkspaceModeChoice;
  onModeChoiceChange: (choice: WorkspaceModeChoice) => void;
  onWorktreesCleaned?: () => void;
}

interface CleanupResult {
  removed: number;
  failed: string[];
  skippedInUse: string[];
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
  projectId,
  readyWorktrees,
  modeChoice,
  onModeChoiceChange,
  onWorktreesCleaned,
}: TerminalWorkspaceMetaProps) {
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleCleanup = async () => {
    setShowConfirm(false);
    setCleaning(true);
    setCleanupMessage(null);
    try {
      const result = await apiDelete<CleanupResult>(`/api/projects/${projectId}/worktrees`);
      const parts = [`Removed ${result.removed} worktree(s)`];
      if (result.skippedInUse.length > 0) parts.push(`${result.skippedInUse.length} skipped (in use)`);
      if (result.failed.length > 0) parts.push(`${result.failed.length} failed`);
      setCleanupMessage(parts.join(' · '));
      onWorktreesCleaned?.();
    } catch (error) {
      setCleanupMessage(error instanceof Error ? error.message : 'Cleanup failed');
    } finally {
      setCleaning(false);
    }
  };

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
        {workspaceMode === 'isolated' && readyWorktrees > 0 ? (
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            disabled={cleaning}
            className="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted hover:border-warn hover:text-warn disabled:opacity-50"
            title="Delete all worktrees for this project (for testing cleanup)"
            data-testid="cleanup-worktrees"
          >
            {cleaning ? 'Cleaning...' : 'Clean up worktrees'}
          </button>
        ) : null}
        <ConfirmationModal
          open={showConfirm}
          title="Clean up worktrees?"
          message={`Delete all worktrees for "${projectName}"? This cannot be undone. Worktrees in use by running terminals will be skipped.`}
          confirmLabel="Yes, delete"
          danger
          onConfirm={() => void handleCleanup()}
          onCancel={() => setShowConfirm(false)}
        />
        {cleanupMessage ? (
          <span className="text-[11px] text-muted" role="status">{cleanupMessage}</span>
        ) : null}
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
