import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { apiPost } from '../lib/api';
import { ConfirmationModal } from './ConfirmationModal';

interface CommitPushButtonProps {
  sessionId: string;
  taskDescription: string;
}

export function CommitPushButton({ sessionId, taskDescription }: CommitPushButtonProps) {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Generate a commit message from the task description (first line, truncated)
  const firstLine = taskDescription.split('\n')[0]?.trim() ?? '';
  const commitMsg = firstLine.length > 100
    ? firstLine.slice(0, 97) + '...'
    : firstLine || 'DevPilot: task completed';

  const commitAndPush = async () => {
    setShowConfirm(false);
    setSending(true);
    setMessage(null);
    try {
      const result = await apiPost<{
        committed: boolean;
        commitSha: string | null;
        pushed: boolean;
      }>(`/api/sessions/${sessionId}/commit-push`, {
        message: commitMsg,
      });
      if (!result.committed) {
        setMessage('No changes to commit.');
      } else if (result.pushed) {
        setMessage(`Committed ${result.commitSha?.slice(0, 7)} and pushed!`);
      } else {
        setMessage(`Committed ${result.commitSha?.slice(0, 7)} (push failed - check remote).`);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Commit failed.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="inline-block">
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setShowConfirm(true)}
        disabled={sending}
        title="Commit all changes in the project and push to origin"
      >
        <GitBranch className="h-3.5 w-3.5" />
        {sending ? 'Committing...' : 'Commit & Push'}
      </button>
      <ConfirmationModal
        open={showConfirm}
        title="Commit and push?"
        message={`Commit all changes with message "${commitMsg}" and push to origin?`}
        confirmLabel="Yes, commit & push"
        danger
        onConfirm={() => void commitAndPush()}
        onCancel={() => setShowConfirm(false)}
      />
      {message && (
        <p className="mt-1 text-xs text-muted">{message}</p>
      )}
    </div>
  );
}
