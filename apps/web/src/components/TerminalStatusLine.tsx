import { RefreshCw } from 'lucide-react';
import type { WorkspaceMode } from '../lib/types';
import { Notice } from './Notice';
import { TerminalFolderNotice } from './TerminalFolderNotice';
import { TerminalWorkspaceMeta } from './TerminalWorkspaceMeta';

interface TerminalStatusLineProps {
  loadError: string | null;
  actionError: string | null;
  onRetry: () => void;
  onDismissActionError: () => void;
  showWorkspace: boolean;
  workspaceMode: WorkspaceMode | null;
  projectName: string;
  projectPath: string;
  readyWorktrees: number;
  modeChoice: WorkspaceMode | '';
  onModeChoiceChange: (choice: WorkspaceMode | '') => void;
  onOpenConversion: () => void;
}

/**
 * A single status line above the terminal panes. Only the highest-priority
 * item is shown: errors, then the shared-folder warning, then workspace mode.
 */
export function TerminalStatusLine({
  loadError,
  actionError,
  onRetry,
  onDismissActionError,
  showWorkspace,
  workspaceMode,
  projectName,
  projectPath,
  readyWorktrees,
  modeChoice,
  onModeChoiceChange,
  onOpenConversion,
}: TerminalStatusLineProps) {
  if (loadError) {
    return (
      <Notice
        tone="danger"
        action={{ label: 'Retry', onClick: onRetry, icon: RefreshCw }}
      >
        Live status could not be refreshed: {loadError}
      </Notice>
    );
  }

  if (actionError) {
    return (
      <Notice tone="danger" onDismiss={onDismissActionError}>
        {actionError}
      </Notice>
    );
  }

  if (!showWorkspace) return null;

  if (workspaceMode === 'shared') {
    return <TerminalFolderNotice onOpenConversion={onOpenConversion} />;
  }

  return (
    <TerminalWorkspaceMeta
      workspaceMode={workspaceMode}
      projectName={projectName}
      projectPath={projectPath}
      readyWorktrees={readyWorktrees}
      modeChoice={modeChoice}
      onModeChoiceChange={onModeChoiceChange}
    />
  );
}
