import { Notice } from './Notice';

interface TerminalFolderNoticeProps {
  onOpenConversion: () => void;
}

/**
 * Shared warning for sessions that write into one physical folder. Rendered
 * through the shared Notice so the app has a single warning voice.
 */
export function TerminalFolderNotice({ onOpenConversion }: TerminalFolderNoticeProps) {
  return (
    <Notice
      tone="warn"
      action={{ label: 'Convert to isolated', onClick: onOpenConversion }}
    >
      <span className="font-semibold">Shared folder.</span> All terminals edit the same files, so
      concurrent agent tasks are blocked and file leases are advisory only. Stop its terminals,
      then convert the saved session to isolated worktrees in Advanced Details for enforceable
      coordination; your files will not be moved or deleted.
    </Notice>
  );
}
