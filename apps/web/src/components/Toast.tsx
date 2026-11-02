import { X, AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import { useCountupKey } from '../hooks/useCountup';

export type ToastTone = 'info' | 'warn' | 'danger' | 'success';

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  info: Info,
  warn: AlertTriangle,
  danger: AlertCircle,
  success: CheckCircle2,
};

const TONE_ACCENT: Record<ToastTone, string> = {
  info: 'border-l-primary',
  warn: 'border-l-warn',
  danger: 'border-l-danger',
  success: 'border-l-ok',
};

export function Toast({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const key = useCountupKey(toast.id);
  const Icon = TONE_ICON[toast.tone];

  return (
    <div
      key={key}
      className={`animate-daemon-in flex items-start gap-2 border-l-2 px-3 py-2 text-sm text-ink ${TONE_ACCENT[toast.tone]} bg-panel rounded-r-lg shadow-lg`}
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <Icon className="mt-0.5 shrink-0 text-current" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{toast.title}</p>
        {toast.message && <p className="mt-0.5 text-muted text-xs">{toast.message}</p>}
        {toast.action && (
          <button
            type="button"
            className="mt-1.5 btn btn-sm btn-primary"
            onClick={toast.action.onClick}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="btn-icon shrink-0 text-muted hover:text-ink"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

/**
 * Toast container with staggered entrance animations.
 * Multiple toasts stagger in from top-right.
 */
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-full pointer-events-none">
      {toasts.map((toast, index) => (
        <div
          key={toast.id}
          className="pointer-events-auto"
          style={{ '--dp-delay': `${index * 80}ms` } as React.CSSProperties}
        >
          <Toast toast={toast} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}