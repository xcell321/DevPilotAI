import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-panel border border-dashed border-lineStrong bg-panel px-6 py-14 text-center">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-panel border border-line bg-panel-2 text-muted">
        <Icon className="h-5 w-5" />
      </div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
