import { useState } from 'react';
import type { ToolProfile } from '../lib/types';
import {
  AVAILABLE_SKILLS,
  defaultModelFor,
  modelsFor,
  type TaskOverride,
} from '../lib/taskConfig';

interface TaskConfigPickerProps {
  /** The planner's auto-assigned tool ID for this task. */
  assignedToolId: string;
  /** All CLI profiles (for the dropdown). */
  tools: ToolProfile[];
  /** Current override values. */
  value: TaskOverride;
  /** Called when any value changes. */
  onChange: (next: TaskOverride) => void;
  disabled?: boolean;
}

/**
 * Per-task CLI / Model / Skills picker.
 * Rendered inside each task card in the Review plan stage.
 * Lets the user override the planner's auto-assignment —
 * primarily for free-tier quota management.
 */
export function TaskConfigPicker({
  assignedToolId,
  tools,
  value,
  onChange,
  disabled = false,
}: TaskConfigPickerProps) {
  const [skillsOpen, setSkillsOpen] = useState(false);

  const launchable = tools.filter((tool) => tool.launchable);
  const effectiveToolId = value.toolId ?? assignedToolId;
  const modelOptions = modelsFor(effectiveToolId);
  const selectedSkills = value.skills ?? [];

  const handleToolChange = (toolId: string) => {
    const next: TaskOverride = {
      ...value,
      toolId: toolId === assignedToolId ? undefined : toolId,
    };
    // Auto-select the default model for the new CLI.
    const defaultModel = defaultModelFor(toolId);
    if (defaultModel) {
      next.model = defaultModel;
    } else {
      delete next.model;
    }
    onChange(next);
  };

  const handleModelChange = (model: string) => {
    onChange({ ...value, model });
  };

  const toggleSkill = (skillId: string) => {
    const has = selectedSkills.includes(skillId);
    const next = has
      ? selectedSkills.filter((id) => id !== skillId)
      : [...selectedSkills, skillId];
    onChange({ ...value, skills: next });
  };

  const isOverridden = value.toolId !== undefined && value.toolId !== assignedToolId;

  return (
    <div className="mt-2 rounded border border-line bg-panel p-2" data-testid="task-config-picker">
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-[11px] text-muted">
          <span className="font-medium text-brass">CLI</span>
          {isOverridden ? <span className="ml-1 text-[10px] text-warn">(changed)</span> : null}
          <select
            className="input mt-1 w-full"
            value={effectiveToolId}
            disabled={disabled}
            onChange={(event) => handleToolChange(event.target.value)}
            data-testid="task-cli-select"
          >
            {launchable.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          <span className="font-medium text-brass">Model</span>
          <select
            className="input mt-1 w-full"
            value={value.model ?? defaultModelFor(effectiveToolId) ?? modelOptions[0]}
            disabled={disabled}
            onChange={(event) => handleModelChange(event.target.value)}
            data-testid="task-model-select"
          >
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <div className="text-[11px] text-muted">
          <span className="font-medium text-brass">
            Skills{selectedSkills.length > 0 ? ` (${selectedSkills.length})` : ''}
          </span>
          <button
            type="button"
            className="btn btn-sm mt-1 w-full"
            onClick={() => setSkillsOpen((open) => !open)}
            disabled={disabled}
            aria-expanded={skillsOpen}
            data-testid="task-skills-toggle"
          >
            {skillsOpen ? 'Hide skills' : 'Select skills'}
          </button>
        </div>
      </div>
      {skillsOpen ? (
        <div className="mt-2 grid max-h-40 gap-1 overflow-y-auto md:grid-cols-2" data-testid="task-skills-list">
          {AVAILABLE_SKILLS.map((skill) => (
            <label
              key={skill.id}
              className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 hover:bg-line/50"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selectedSkills.includes(skill.id)}
                disabled={disabled}
                onChange={() => toggleSkill(skill.id)}
                data-testid={`task-skill-${skill.id}`}
              />
              <span>
                <span className="font-medium text-ink">{skill.name}</span>
                <span className="block text-[10px] text-muted">{skill.description}</span>
              </span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
