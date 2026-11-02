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
    <div className="panel group p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-lineStrong hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
        <span className="rounded-lg bg-primary-soft p-1.5 text-primary transition-colors group-hover:bg-primary group-hover:text-app">
          {icon}
        </span>
      </div>
      <p
        key={key}
        className="mt-3 font-serif text-3xl font-semibold tracking-tight text-ink stat-counter animate-tick"
        data-testid={testId}
      >
        {value ?? '—'}
      </p>
      <p className="mt-1.5 text-[11px] leading-5 text-muted">{hint}</p>
    </div>
  );
}