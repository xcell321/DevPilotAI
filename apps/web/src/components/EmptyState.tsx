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
    <div className="dp-fade-in flex flex-col items-center justify-center rounded-panel border border-dashed border-lineStrong bg-panel px-6 py-14 text-center">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary-soft text-primary">
        <Icon className="h-6 w-6" />
      </div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
