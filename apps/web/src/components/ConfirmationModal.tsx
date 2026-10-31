import { AlertTriangle } from 'lucide-react';

interface ConfirmationModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationModal({
  open,
  title,
  message,
  confirmLabel = 'Yes',
  cancelLabel = 'No',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmationModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      data-testid="confirmation-modal"
    >
      <div
        className="w-full max-w-md rounded-lg border border-line bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          {danger ? (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
          ) : null}
          <div className="min-w-0">
            <h3 className="font-medium text-ink">{title}</h3>
            <p className="mt-1 text-sm text-muted">{message}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-sm"
            data-testid="confirmation-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid="confirmation-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
