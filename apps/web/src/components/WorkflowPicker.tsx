import { ChevronDown, Loader2, Search } from 'lucide-react';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { apiGet } from '../lib/api';
import type { ToolProfile } from '../lib/types';
import { errorMessage } from '../lib/errors';

export interface WorkflowPickerProps {
  tools: ToolProfile[] | null;
  selectedToolId: string | null;
  onToolChange: (toolId: string) => void;
  selectedModel: string | null;
  onModelChange: (model: string) => void;
  selectedSkills: string[];
  onSkillsChange: (skills: string[]) => void;
  busy: boolean;
  disabled?: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  category: 'backend' | 'frontend' | 'security' | 'utility';
}

interface SkillGroup {
  category: string;
  skills: Skill[];
}

const CATEGORY_LABELS: Record<Skill['category'], string> = {
  backend: 'Backend',
  frontend: 'Frontend',
  security: 'Security',
  utility: 'Utility',
};

const CATEGORY_ORDER: Skill['category'][] = ['backend', 'frontend', 'security', 'utility'];

const MODEL_OPTIONS: Record<string, string[]> = {
  claude: ['Claude Opus 4', 'Claude Sonnet 4', 'Claude Haiku 3.5'],
  opencode: ['OpenCode Default', 'OpenCode GPT-4', 'OpenCode Custom'],
  freebuff: ['Freebuff Default'],
  antigravity: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash'],
  copilot: ['GPT-4o', 'GPT-4o Mini', 'GPT-4 Turbo'],
};

function getModelsForTool(toolId: string | null): string[] {
  return toolId ? MODEL_OPTIONS[toolId] ?? ['Default'] : ['Default'];
}

export function WorkflowPicker({
  tools,
  selectedToolId,
  onToolChange,
  selectedModel,
  onModelChange,
  selectedSkills,
  onSkillsChange,
  busy,
  disabled = false,
}: WorkflowPickerProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCategories, setExpandedCategories] = useState({
    backend: true,
    frontend: true,
    security: true,
    utility: true,
  } as Record<string, boolean>);

  const fetchSkills = useCallback(async () => {
    try {
      const result = await apiGet<{ skills: Skill[] }>('/api/skills');
      setSkills(result.skills);
    } catch (cause) {
      setSkillsError(errorMessage(cause, 'Could not load skills.'));
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  const groupedSkills = useMemo((): SkillGroup[] => {
    const groups = new Map<Skill['category'], Skill[]>();
    for (const skill of skills) {
      const group = groups.get(skill.category) ?? [];
      group.push(skill);
      groups.set(skill.category, group);
    }
    return CATEGORY_ORDER.map((category) => ({
      category,
      skills: groups.get(category) ?? [],
    })).filter((group) => group.skills.length > 0);
  }, [skills]);

  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groupedSkills;
    const query = searchQuery.toLowerCase();
    return groupedSkills
      .map((group) => {
        return {
          ...group,
          skills: group.skills.filter(
            (skill) =>
              skill.name.toLowerCase().includes(query) ||
              skill.description.toLowerCase().includes(query) ||
              skill.id.toLowerCase().includes(query),
          ),
        };
      })
      .filter((group) => group.skills.length > 0);
  }, [groupedSkills, searchQuery]);

  const availableModels = getModelsForTool(selectedToolId);
  const modelValid = availableModels.includes(selectedModel ?? 'Default');

  const handleToggleSkill = useCallback((skillId: string) => {
    if (selectedSkills.includes(skillId)) {
      onSkillsChange(selectedSkills.filter((id) => id !== skillId));
    } else {
      onSkillsChange([...selectedSkills, skillId]);
    }
  }, [selectedSkills, onSkillsChange]);

  const handleCategoryToggle = useCallback((category: string) => {
    setExpandedCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  }, []);

  const handleSelectAllInCategory = useCallback((skillIds: string[]) => {
    const allSelected = skillIds.every((id) => selectedSkills.includes(id));
    if (allSelected) {
      onSkillsChange(selectedSkills.filter((id) => !skillIds.includes(id)));
    } else {
      onSkillsChange([...selectedSkills, ...skillIds.filter((id) => !selectedSkills.includes(id))]);
    }
  }, [selectedSkills, onSkillsChange]);

  const categoryAllSelected = useCallback((skillIds: string[]) =>
    skillIds.length > 0 && skillIds.every((id) => selectedSkills.includes(id)),
  [selectedSkills]);

  if (busy) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading workflow options…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="workflow-picker">
      {/* CLI Dropdown */}
      <label className="block text-[11px] text-muted">
        CLI Profile
        <select
          className="input mt-1 w-full"
          value={selectedToolId || ''}
          onChange={(e) => onToolChange(e.target.value)}
          disabled={disabled || tools === null || tools.length === 0}
        >
          {tools?.map((tool) => (
            <option key={tool.id} value={tool.id} disabled={!tool.launchable}>
              {tool.displayName} {tool.launchable ? '' : '(not launchable)'}
            </option>
          ))}
        </select>
        {tools?.filter((t) => !t.launchable).length && (
          <p className="mt-1 text-[10px] text-muted">
            Non-launchable profiles cannot be used for workflow tasks.
          </p>
        )}
      </label>

      {/* Model Dropdown */}
      <label className="block text-[11px] text-muted">
        Model
        <select
          className="input mt-1 w-full"
          value={selectedModel || ''}
          onChange={(e) => onModelChange(e.target.value)}
          disabled={disabled || !modelValid}
        >
          {availableModels.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
          {!modelValid && (
            <option value={selectedModel || ''} disabled>
              {selectedModel || ''} (not available for this CLI)
            </option>
          )}
        </select>
        {!modelValid && (
          <p className="mt-1 text-[10px] text-danger">
            Selected model is not available for the chosen CLI. Please choose a valid model.
          </p>
        )}
      </label>

      {/* Skills Checklist */}
      <label className="block text-[11px] text-muted">
        Skills <span className="font-normal text-xs">({selectedSkills.length} selected)</span>
        <div className="mt-1 relative">
          <div className="input flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
            <input
              type="text"
              placeholder="Search skills…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-transparent text-ink placeholder:text-muted focus:outline-none"
            />
          </div>
          {skillsError && (
            <div className="absolute top-full left-0 right-0 mt-1 px-3 py-2 text-[11px] text-danger bg-danger-soft border border-danger rounded-lg">
              {skillsError}
            </div>
          )}
        </div>

        <div className="mt-2 max-h-64 overflow-y-auto space-y-2 border border-line bg-panel rounded-lg p-2">
          {filteredGroups.map((group) => {
            const skillIds = group.skills.map((s: Skill) => s.id);
            const allSel = categoryAllSelected(skillIds);

            return (
              <details
                key={group.category}
                className="group"
                open={expandedCategories[group.category]}
                onToggle={() => handleCategoryToggle(group.category)}
              >
                <summary className="flex items-center gap-2 cursor-pointer text-xs font-medium text-ink">
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${expandedCategories[group.category] ? 'rotate-180' : ''}`}
                  />
                  <span className="flex-1">
                    {CATEGORY_LABELS[group.category as keyof typeof CATEGORY_LABELS]} ({group.skills.length})
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm px-2 py-0.5 text-[10px]"
                    onClick={(e) => {
                      e.preventDefault();
                      handleSelectAllInCategory(skillIds);
                    }}
                    disabled={disabled}
                  >
                    {allSel ? 'Deselect all' : 'Select all'}
                  </button>
                </summary>
                <div className="mt-1 ml-5 space-y-1 border-l border-line pl-2">
                  {group.skills.map((skill: Skill) => (
                    <label
                      key={skill.id}
                      className="flex items-start gap-2 cursor-pointer text-[11px] text-ink hover:text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSkills.includes(skill.id)}
                        onChange={() => handleToggleSkill(skill.id)}
                        disabled={disabled}
                        className="mt-0.5 h-3.5 w-3.5 rounded border-line bg-app text-primary focus:ring-primary focus:ring-offset-0 focus:ring-offset-app"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{skill.name}</p>
                        <p className="text-[10px] text-muted truncate">{skill.description}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </details>
            );
          })}
          {skills.length === 0 && !skillsError && (
            <p className="text-center text-[11px] text-muted py-4">Loading skills…</p>
          )}
          {filteredGroups.length === 0 && searchQuery && (
            <p className="text-center text-[11px] text-muted py-4">No skills match your search.</p>
          )}
        </div>
      </label>
    </div>
  );
}