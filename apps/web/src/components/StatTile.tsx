import { type ReactNode } from 'react';
import { useCountupKey } from '../hooks/useCountup';

interface StatTileProps {
  label: string;
  value: number | null;
  hint: string;
  icon: ReactNode;
  testId?: string;
}

/**
 * A single metric tile that re-animates its value whenever it changes.
 * Uses a changing key on the value element so the `animate-tick`
 * CSS keyframe re-runs on every numeric update.
 */
export function StatTile({ label, value, hint, icon, testId }: StatTileProps) {
  const key = useCountupKey(value);
  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted">{label}</p>
        <span className="text-muted">{icon}</span>
      </div>
      <p
        key={key}
        className="mt-3 text-2xl font-semibold tracking-tight text-ink stat-counter animate-tick"
        data-testid={testId}
      >
        {value ?? '—'}
      </p>
      <p className="mt-1 text-[11px] text-muted">{hint}</p>
    </div>
  );
}