import { GitMerge, Loader2, Pause, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import type { OrchestrationCapacity, SessionOrchestrationSummary } from '../lib/types';
import { StatStrip } from './StatStrip';

interface OrchestrationToolbarProps {
  summary: SessionOrchestrationSummary | null;
  capacity: OrchestrationCapacity | null;
  busyKey: string | null;
  onSchedule: () => void;
  onProcessQueue: () => void;
  onToggleScheduling: () => void;
  onRefresh: () => void;
}

export function OrchestrationToolbar({
  summary,
  capacity,
  busyKey,
  onSchedule,
  onProcessQueue,
  onToggleScheduling,
  onRefresh,
}: OrchestrationToolbarProps) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <GitMerge className="h-4 w-4 shrink-0 text-muted" />
          <span className="text-sm font-medium text-ink">Task orchestration</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onSchedule}
            disabled={busyKey !== null}
            data-testid="orchestration-schedule"
          >
            {busyKey === 'schedule' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Schedule ready tasks
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onProcessQueue}
            disabled={busyKey !== null}
            data-testid="orchestration-process-queue"
          >
            {busyKey === 'queue' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            Run integration queue
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onToggleScheduling}
            disabled={busyKey !== null || !summary}
            data-testid="orchestration-pause"
          >
            {busyKey === 'scheduling' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : summary?.schedulingPaused ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <Pause className="h-3.5 w-3.5" />
            )}
            {summary?.schedulingPaused ? 'Resume scheduling' : 'Pause scheduling'}
          </button>
          <button
            type="button"
            className="btn btn-icon"
            onClick={onRefresh}
            aria-label="Refresh orchestration state"
            data-testid="orchestration-refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {capacity ? (
        <StatStrip
          columns={3}
          items={[
            {
              label: 'Agents',
              value: `${capacity.activeAgents}/${capacity.maxConcurrentAgents}`,
            },
            {
              label: 'Live terminals',
              value: `${capacity.liveTerminals}/${capacity.maxLiveTerminals}`,
            },
            { label: 'Backend cap', value: String(capacity.systemMaxConcurrentAgents) },
          ]}
        />
      ) : null}
    </>
  );
}
