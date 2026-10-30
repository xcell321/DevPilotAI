import { Loader2, Plus, Trash2 } from 'lucide-react';
import type { OrchestrationSettings } from '../lib/types';

export interface CommandDraft {
  key: string;
  name: string;
  command: string;
  args: string;
  timeoutSeconds: string;
  required: boolean;
}

export interface SettingsDraft {
  autoIntegrate: boolean;
  maxConcurrentAgents: number;
  targetBranch: string;
  protectedPaths: string;
  commands: CommandDraft[];
}

interface OrchestrationSettingsFormProps {
  settings: OrchestrationSettings | null;
  draft: SettingsDraft | null;
  open: boolean;
  busyKey: string | null;
  onToggle: (open: boolean) => void;
  onDraftChange: (patch: Partial<SettingsDraft>) => void;
  onCommandChange: (key: string, patch: Partial<CommandDraft>) => void;
  onSave: () => void;
}

function draftKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `row-${Math.random().toString(36).slice(2)}`;
}

export function OrchestrationSettingsForm({
  settings,
  draft,
  open,
  busyKey,
  onToggle,
  onDraftChange,
  onCommandChange,
  onSave,
}: OrchestrationSettingsFormProps) {
  return (
    <details
      className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11px] text-muted"
      open={open}
      onToggle={(event) => onToggle((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="disclosure-summary">
        Project orchestration settings (validation checks, integration, concurrency)
      </summary>
      {draft && settings ? (
        <div className="mt-3 flex flex-col gap-3">
        <label className="flex items-center gap-2 text-ink">
          <input
            type="checkbox"
            checked={draft.autoIntegrate}
            onChange={(event) => onDraftChange({ autoIntegrate: event.target.checked })}
            data-testid="auto-integrate"
          />
          Integrate completed tasks automatically after all required checks pass
        </label>
        <p className="text-[11px] text-muted">
          Off by default. When disabled, completed tasks wait in the integration queue until you
          press Integrate.
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-[11px] text-muted">
            Maximum concurrent agents for this project (backend cap{' '}
            {settings.systemMaxConcurrentAgents})
            <input
              type="number"
              min={1}
              max={settings.systemMaxConcurrentAgents}
              className="input mt-1"
              value={draft.maxConcurrentAgents}
              onChange={(event) =>
                onDraftChange({ maxConcurrentAgents: Number(event.target.value) || 1 })
              }
              data-testid="max-concurrent-agents"
            />
          </label>
          <label className="text-[11px] text-muted">
            Integration target branch (blank uses {settings.resolvedTargetBranch})
            <input
              className="input mt-1 mono"
              value={draft.targetBranch}
              placeholder={settings.resolvedTargetBranch}
              onChange={(event) => onDraftChange({ targetBranch: event.target.value })}
              data-testid="target-branch"
            />
          </label>
        </div>

        <label className="text-[11px] text-muted">
          Protected paths (one repository-relative path per line; changes there are never
          integrated)
          <textarea
            className="input mt-1 min-h-16 w-full font-mono"
            value={draft.protectedPaths}
            onChange={(event) => onDraftChange({ protectedPaths: event.target.value })}
            data-testid="protected-paths"
          />
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-ink">Validation checks</span>
          {draft.commands.length === 0 ? (
            <p className="text-[11px] text-muted">
              No checks configured. Integration then requires an explicit acknowledgement that
              nothing was validated.
            </p>
          ) : null}
          {draft.commands.map((row) => (
            <div
              key={row.key}
              className="grid gap-1.5 rounded-lg border border-line bg-app p-2 md:grid-cols-2"
            >
              <input
                className="input"
                placeholder="Check name (for example typecheck)"
                value={row.name}
                onChange={(event) => onCommandChange(row.key, { name: event.target.value })}
              />
              <input
                className="input mono"
                placeholder="node, npm, or an absolute executable path"
                value={row.command}
                onChange={(event) => onCommandChange(row.key, { command: event.target.value })}
              />
              <textarea
                className="input min-h-16 font-mono md:col-span-2"
                placeholder="One argument per line, for example:&#10;run&#10;typecheck"
                value={row.args}
                onChange={(event) => onCommandChange(row.key, { args: event.target.value })}
              />
              <label className="flex items-center gap-2 text-[11px] text-muted">
                Timeout (seconds)
                <input
                  type="number"
                  min={1}
                  className="input w-24"
                  value={row.timeoutSeconds}
                  onChange={(event) =>
                    onCommandChange(row.key, { timeoutSeconds: event.target.value })
                  }
                />
              </label>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={row.required}
                    onChange={(event) =>
                      onCommandChange(row.key, { required: event.target.checked })
                    }
                  />
                  Required before integration
                </label>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    onDraftChange({
                      commands: draft.commands.filter((entry) => entry.key !== row.key),
                    })
                  }
                  aria-label="Remove this validation check"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-sm w-fit"
            onClick={() =>
              onDraftChange({
                commands: [
                  ...draft.commands,
                  {
                    key: draftKey(),
                    name: '',
                    command: 'node',
                    args: '',
                    timeoutSeconds: '300',
                    required: true,
                  },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add validation check
          </button>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-sm w-fit"
          onClick={onSave}
          disabled={busyKey !== null}
          data-testid="save-orchestration-settings"
        >
          {busyKey === 'settings' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save settings
        </button>
        </div>
      ) : null}
    </details>
  );
}
