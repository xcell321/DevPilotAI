import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { apiGet, apiPost } from '../lib/api';
import type { SessionSummary, SessionTerminal } from '../lib/types';

interface SendToTerminalButtonProps {
  taskId: string;
  taskDescription: string;
}

interface LiveTerminalOption {
  terminalId: string;
  label: string;
  sessionName: string;
}

export function SendToTerminalButton({ taskId, taskDescription }: SendToTerminalButtonProps) {
  const [open, setOpen] = useState(false);
  const [terminals, setTerminals] = useState<LiveTerminalOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadTerminals = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await apiGet<{ sessions: SessionSummary[] }>('/api/sessions');
      const options: LiveTerminalOption[] = [];
      for (const session of result.sessions) {
        // Fetch full session to get terminals with live status
        try {
          const detail = await apiGet<{ session: SessionSummary }>(
            `/api/sessions/${session.id}`,
          );
          for (const t of detail.session.terminals ?? []) {
            const terminal = t as SessionTerminal & { live?: boolean };
            // Only include terminals that appear live (we check via hasLive on backend at send time)
            options.push({
              terminalId: terminal.id,
              label: `${terminal.toolName ?? 'Terminal'} (${terminal.id.slice(0, 8)})`,
              sessionName: detail.session.title ?? session.id.slice(0, 8),
            });
          }
        } catch {
          // Skip sessions we can't read
        }
      }
      setTerminals(options);
      if (options.length === 0) {
        setMessage('No terminals found. Open a CLI terminal first.');
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not load terminals.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      void loadTerminals();
    }
  }, [open ]);

  const sendTo = async (terminalId: string) => {
    setSending(true);
    setMessage(null);
    try {
      await apiPost(`/api/orchestration/tasks/${taskId}/send-to-terminal`, {
        terminalId,
      });
      setMessage('Task sent! Check the terminal.');
      setOpen(false);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Failed to send task.');
    } finally {
      setSending(false);
    }
  };

  if (!taskDescription.trim()) return null;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(!open)}
        title="Type this task into one of your open CLI terminals"
      >
        <Send className="h-3.5 w-3.5" />
        Send to terminal
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-64 rounded-lg border border-line bg-panel p-2 shadow-lg">
          {loading ? (
            <p className="px-2 py-1 text-xs text-muted">Loading terminals...</p>
          ) : terminals.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">
              {message ?? 'No terminals available.'}
            </p>
          ) : (
            terminals.map((t) => (
              <button
                key={t.terminalId}
                type="button"
                className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-hover"
                onClick={() => void sendTo(t.terminalId)}
                disabled={sending}
              >
                <span className="font-medium">{t.label}</span>
                <span className="block text-muted">in {t.sessionName}</span>
              </button>
            ))
          )}
          {message && terminals.length > 0 && (
            <p className="px-2 py-1 text-xs text-muted">{message}</p>
          )}
          <button
            type="button"
            className="mt-1 block w-full rounded px-2 py-1 text-center text-xs text-muted hover:bg-hover"
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {message && !open && (
        <p className="mt-1 text-xs text-muted">{message}</p>
      )}
    </div>
  );
}
