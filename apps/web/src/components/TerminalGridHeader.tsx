import type { TerminalLayout } from '../lib/types';

interface TerminalGridHeaderProps {
  visibleCount: number;
  terminalLimit: number | null;
  limitReached: boolean;
  layoutPreset: TerminalLayout;
  onLayoutPresetChange: (preset: TerminalLayout) => void;
  maximized: boolean;
}

const LAYOUT_OPTIONS: { value: TerminalLayout; label: string }[] = [
  { value: 'auto', label: 'Auto (balanced)' },
  { value: 'single', label: 'Focus active terminal' },
  { value: 'horizontal', label: 'Horizontal split' },
  { value: 'vertical', label: 'Vertical split' },
  { value: 'grid', label: 'Balanced grid' },
];

export function TerminalGridHeader({
  visibleCount,
  terminalLimit,
  limitReached,
  layoutPreset,
  onLayoutPresetChange,
  maximized,
}: TerminalGridHeaderProps) {
  const countLabel = [
    `${visibleCount} terminal${visibleCount === 1 ? '' : 's'}`,
    terminalLimit === null ? null : `${terminalLimit} max`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1 text-[11px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="eyebrow text-ink">{countLabel}</span>
        {limitReached ? (
          <span className="text-warn">
            Limit reached — closing stops a process but keeps its saved slot; reopen saved
            terminals from the selector.
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <select
          className="input w-auto py-0.5 text-[11px]"
          aria-label="Terminal layout"
          value={layoutPreset}
          onChange={(event) => onLayoutPresetChange(event.target.value as TerminalLayout)}
          data-testid="terminal-layout-select"
        >
          {LAYOUT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="text-muted">
          {maximized ? 'Panel maximized' : 'Drag dividers to resize'}
        </span>
      </div>
    </div>
  );
}
