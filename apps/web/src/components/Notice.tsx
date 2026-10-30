import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type NoticeTone = 'info' | 'warn' | 'danger' | 'success';

export interface NoticeAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon?: LucideIcon;
}

interface NoticeProps {
  tone?: NoticeTone;
  action?: NoticeAction;
  onDismiss?: () => void;
  children: ReactNode;
}

const TONE_ICON: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warn: AlertTriangle,
  danger: AlertCircle,
  success: CheckCircle2,
};

const TONE_ACCENT: Record<NoticeTone, string> = {
  info: 'border-l-primary bg-primary-soft',
  warn: 'border-l-warn bg-warn-soft',
  danger: 'border-l-danger bg-danger-soft',
  success: 'border-l-ok bg-ok-soft',
};

export function Notice({ tone = 'info', action, onDismiss, children }: NoticeProps) {
  const Icon = TONE_ICON[tone];
  const ActionIcon = action?.icon;

  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex items-start gap-2 border-l-2 px-3 py-2 text-xs leading-relaxed text-ink ${TONE_ACCENT[tone]}`}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action ? (
        <button
          type="button"
          className="btn btn-sm shrink-0"
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {ActionIcon ? <ActionIcon className="h-3.5 w-3.5" /> : null}
          {action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          className="btn-icon shrink-0 text-muted hover:text-ink"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
