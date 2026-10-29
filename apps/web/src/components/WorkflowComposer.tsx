import { AlertTriangle, Loader2, Play, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import type {
  OrchestrationSettings,
  Project,
  SessionOrchestrationSummary,
  SessionSummary,
  ToolProfile,
  WorkflowPlanSummary,
  WorkflowSummary,
} from '../lib/types';

interface WorkflowComposerProps {
  onWorkflowStarted: (session: SessionSummary) => void;
  session: SessionSummary | null;
  compact?: boolean;
}

interface WorkflowPreview {
  projectId: string;
  prompt: string;
  plan: WorkflowPlanSummary;
  planFingerprint: string;
}

interface WorkflowState {
  summary: SessionOrchestrationSummary;
  workflow: WorkflowSummary;
}

function briefText(value: string, maxLength = 140): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function taskTitle(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s+/)[0] ?? description;
  return briefText(firstSentence, 78);
}

function taskStateLabel(state: SessionOrchestrationSummary['tasks'][number]): string {
  if (state.state === 'running') return 'Working';
  if (state.state === 'validating') return 'Checking changes';
  if (state.state === 'awaiting_integration') return 'Ready for review';
  if (state.state === 'integrated') return 'Completed';
  if (state.state === 'failed') return 'Needs your attention';
  if (state.state === 'cancelled') return 'Cancelled';
  if (state.state === 'blocked') {
    if (state.waitKind === 'files') return 'Waiting for a file';
    if (state.waitKind === 'dependency') return 'Waiting for another task';
    return 'Blocked';
  }
  return state.state === 'unassigned' ? 'Not started' : 'Queued';
}

function workflowStatus({ summary, workflow }: WorkflowState): string {
  const states = summary.tasks.map((task) => task.state);
  if (summary.schedulingPaused || workflow.status === 'paused') return 'paused';
  if (states.includes('failed')) return 'needs your attention';
  if (states.length > 0 && states.every((state) => state === 'integrated')) return 'completed';
  if (states.length > 0 && states.every((state) => state === 'cancelled')) return 'cancelled';
  if (
    states.includes('awaiting_integration') &&
    states.every((state) => ['integrated', 'awaiting_integration'].includes(state))
  ) {
    return 'awaiting integration';
  }
  if (states.includes('running') || states.includes('validating')) return 'running';
  if (states.some((state) => ['unassigned', 'blocked', 'ready', 'assigned'].includes(state))) {
    return 'queued';
  }
  return workflow.status;
}

export function WorkflowComposer({
  onWorkflowStarted,
  session,
  compact = false,
}: WorkflowComposerProps) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [tools, setTools] = useState<ToolProfile[] | null>(null);
  const [settings, setSettings] = useState<OrchestrationSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [orchestration, setOrchestration] = useState<SessionOrchestrationSummary | null>(null);
  const [orchestrationSessionId, setOrchestrationSessionId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'start' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    void Promise.all([
      apiGet<{ projects: Project[] }>('/api/projects'),
      apiGet<{ tools: ToolProfile[] }>('/api/tools'),
    ])
      .then(([{ projects: available }, { tools: profiles }]) => {
        if (ignore) return;
        setProjects(available);
        setTools(profiles);
        const preferred = available.find((project) => project.pathStatus === 'ok')?.id ?? '';
        setProjectId((current) => current || preferred);
      })
      .catch((cause: unknown) => {
        if (ignore) return;
        setError(cause instanceof Error ? cause.message : 'Projects could not be loaded.');
        setProjects([]);
        setTools([]);
      });
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    if (session) setProjectId(session.project.id);
  }, [session?.id]);

  useEffect(() => {
    if (!projectId) {
      setSettings(null);
      setSettingsError(null);
      return;
    }
    let ignore = false;
    setSettings(null);
    setSettingsError(null);
    void apiGet<{ settings: OrchestrationSettings }>(
      `/api/orchestration/settings?projectId=${encodeURIComponent(projectId)}`,
    )
      .then(({ settings: next }) => {
        if (!ignore) setSettings(next);
      })
      .catch((cause: unknown) => {
        if (ignore) return;
        setSettingsError(
          cause instanceof Error ? cause.message : 'Workflow settings could not be loaded.',
        );
      });
    return () => {
      ignore = true;
    };
  }, [projectId]);

  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId) {
      setOrchestration(null);
      setOrchestrationSessionId(null);
      setStatusError(null);
      return;
    }
    let ignore = false;
    setStatusError(null);
    const refresh = async () => {
      try {
        const result = await apiGet<{ orchestration: SessionOrchestrationSummary }>(
          `/api/orchestration/workflows/${sessionId}`,
        );
        if (ignore) return;
        setOrchestration(result.orchestration);
        setOrchestrationSessionId(sessionId);
        setStatusError(null);
      } catch (cause) {
        if (ignore) return;
        setStatusError(
          cause instanceof Error ? cause.message : 'Workflow status could not be refreshed.',
        );
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      ignore = true;
      window.clearInterval(timer);
    };
  }, [session?.id]);

  const generatePlan = async () => {
    if (!projectId || prompt.trim().length < 8) return;
    setBusy('preview');
    setError(null);
    try {
      const result = await apiPost<{
        plan: WorkflowPlanSummary;
        planFingerprint: string;
      }>('/api/orchestration/workflows/preview', {
        projectId,
        prompt,
      });
      setPreview({
        projectId,
        prompt: prompt.trim(),
        plan: result.plan,
        planFingerprint: result.planFingerprint,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow plan could not be generated.');
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const startWorkflow = async () => {
    if (!preview || preview.projectId !== projectId) return;
    setBusy('start');
    setError(null);
    try {
      const result = await apiPost<{
        workflow: WorkflowSummary;
        session: SessionSummary;
        orchestration: SessionOrchestrationSummary;
      }>('/api/orchestration/workflows', {
        projectId: preview.projectId,
        prompt: preview.prompt,
        planFingerprint: preview.planFingerprint,
      });
      setOrchestration(result.orchestration);
      setOrchestrationSessionId(result.session.id);
      setPreview(null);
      setPrompt('');
      onWorkflowStarted(result.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow could not be started.');
    } finally {
      setBusy(null);
    }
  };

  const resumeWorkflow = async () => {
    if (!projectId) return;
    setBusy('resume');
    setError(null);
    try {
      await apiPut<{ settings: OrchestrationSettings }>('/api/orchestration/settings', {
        projectId,
        schedulingPaused: false,
      });
      setSettings((current) => current ? { ...current, schedulingPaused: false } : current);
      if (session?.project.id === projectId) {
        const result = await apiPost<{ orchestration: SessionOrchestrationSummary }>(
          `/api/orchestration/sessions/${session.id}/schedule`,
        );
        setOrchestration(result.orchestration);
        setOrchestrationSessionId(session.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The workflow could not be resumed.');
    } finally {
      setBusy(null);
    }
  };

  const selectedProject = projects?.find((project) => project.id === projectId) ?? null;
  const activeWorkflow =
    session?.project.id === projectId &&
    orchestrationSessionId === session.id &&
    orchestration?.workflow
      ? { summary: orchestration, workflow: orchestration.workflow }
      : null;
  const tasks = activeWorkflow?.summary.tasks ?? [];
  const runningCount = tasks.filter((task) => task.state === 'running').length;
  const validatingCount = tasks.filter((task) => task.state === 'validating').length;
  const queuedCount = tasks.filter((task) => ['ready', 'assigned'].includes(task.state)).length;
  const waitingCount = tasks.filter((task) => task.state === 'blocked').length;
  const integrationCount = tasks.filter((task) => task.state === 'awaiting_integration').length;
  const failedCount = tasks.filter((task) => task.state === 'failed').length;
  const completedCount = tasks.filter((task) => task.state === 'integrated').length;
  const cancelledCount = tasks.filter((task) => task.state === 'cancelled').length;
  const launchableTools = tools?.filter((tool) => tool.launchable) ?? [];
  const unavailableTools = tools?.filter((tool) => tool.enabled && !tool.launchable) ?? [];
  const workflowPaused = Boolean(
    settings?.schedulingPaused ||
      (session?.project.id === projectId &&
        orchestrationSessionId === session.id &&
        orchestration?.schedulingPaused),
  );
  const previewToolsReady = Boolean(
    preview?.plan.tasks.every((task) =>
      tools?.some((tool) => tool.id === task.toolId && tool.launchable),
    ),
  );
  const needsAttention = failedCount > 0 || tasks.some((task) => {
    const terminal = session?.terminals.find((entry) => entry.id === task.id);
    return terminal?.status === 'error' || terminal?.status === 'unavailable';
  });
  const readinessMessage =
    projects === null || tools === null
      ? 'Checking your project and CLI profiles…'
      : !selectedProject
        ? 'Select an available project to continue.'
        : selectedProject.pathStatus !== 'ok'
          ? 'This project folder is unavailable.'
          : settingsError
            ? 'Workflow readiness could not be confirmed.'
            : settings === null
              ? 'Checking workflow settings…'
              : launchableTools.length === 0
                ? 'No enabled, launch-verified CLI is ready.'
                : workflowPaused
                  ? 'Workflow scheduling is paused.'
                  : 'Ready to start';

  return (
    <section
      className={`panel flex shrink-0 flex-col ${compact ? 'gap-2 p-2' : 'gap-3 p-3'}`}
      aria-labelledby="workflow-composer-title"
      data-testid="workflow-composer"
    >
      <div>
        <h2 id="workflow-composer-title" className="flex items-center gap-2 text-sm font-medium text-ink">
          <Sparkles className="h-4 w-4 text-primary" />
          {activeWorkflow ? 'Workflow dashboard' : 'Start an automatic workflow'}
        </h2>
        {!compact ? (
          <p className="mt-1 text-[11px] text-muted">
            Choose a project and describe the outcome. DevPilot plans isolated tasks for available,
            launch-verified CLI profiles; review the plan before any agent starts.
          </p>
        ) : null}
      </div>

      {unavailableTools.length > 0 && tools !== null ? (
        <div className="rounded border border-line bg-warn-soft px-2.5 py-2 text-[11px] text-ink">
          <p className="font-medium text-warn">
            {unavailableTools.length} enabled CLI profile{unavailableTools.length === 1 ? '' : 's'} need setup.
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {unavailableTools.map((tool) => (
              <li key={tool.id}>
                <span className="font-medium">{tool.displayName}</span>
                {tool.launchReason ? ` — ${tool.launchReason}` : ' — launch verification is required.'}
              </li>
            ))}
          </ul>
          <Link className="mt-1 inline-block text-primary underline" to="/tools">
            Review CLI setup
          </Link>
        </div>
      ) : null}

      <div
        className={`grid gap-2 ${
          compact
            ? 'md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,2fr)_auto] md:items-end'
            : 'md:grid-cols-[minmax(12rem,0.8fr)_minmax(0,2fr)]'
        }`}
      >
        <label className="text-[11px] text-muted">
          Project
          <select
            className="input mt-1 w-full"
            value={projectId}
            disabled={busy !== null || projects === null || projects.length === 0}
            onChange={(event) => {
              setProjectId(event.target.value);
              setPreview(null);
            }}
            data-testid="workflow-project"
          >
            {projects === null ? <option value="">Loading projects...</option> : null}
            {projects?.length === 0 ? <option value="">No projects registered</option> : null}
            {projects?.map((project) => (
              <option
                key={project.id}
                value={project.id}
                disabled={project.pathStatus !== 'ok'}
              >
                {project.name} — {project.pathStatus === 'ok' ? project.path : 'unavailable'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-muted">
          What should the agents accomplish?
          <textarea
            className={`input mt-1 w-full resize-y ${compact ? 'min-h-10' : 'min-h-16'}`}
            maxLength={4000}
            value={prompt}
            disabled={busy !== null}
            placeholder="Describe the outcome in one prompt."
            onChange={(event) => {
              setPrompt(event.target.value);
              setPreview(null);
            }}
            data-testid="workflow-prompt"
          />
        </label>
        {compact && !preview ? (
          <button
            type="button"
            className="btn btn-primary px-3 py-1.5 text-xs"
            onClick={() => void generatePlan()}
            disabled={
              busy !== null ||
              !selectedProject ||
              selectedProject.pathStatus !== 'ok' ||
              launchableTools.length === 0 ||
              settings === null ||
              Boolean(settingsError) ||
              prompt.trim().length < 8
            }
            data-testid="generate-workflow"
          >
            {busy === 'preview' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Generate workflow
          </button>
        ) : null}
      </div>

      {!compact && selectedProject ? (
        <p className="text-[10px] text-muted">
          Workspace: <span className="mono">{selectedProject.path}</span>
        </p>
      ) : !compact && projects?.length === 0 && !error ? (
        <p className="text-[11px] text-muted">
          Register a project before generating an automatic workflow.
        </p>
      ) : !compact && projects?.every((project) => project.pathStatus !== 'ok') ? (
        <p role="alert" className="text-[11px] text-warn">
          No registered project folder is currently available.
        </p>
      ) : null}

      {preview ? (
        <div
          className="rounded-lg border border-line bg-panel-2 p-3 text-[11px]"
          data-testid="workflow-plan-review"
        >
          <h3 className="text-xs font-medium text-ink">Review plan</h3>
          <p className="mt-1 text-ink">
            {preview.plan.tasks.length} isolated task{preview.plan.tasks.length === 1 ? '' : 's'}{' '}
            proposed for {selectedProject?.name ?? 'this project'}.
          </p>
          {preview.plan.conventions.length > 0 ? (
            <p className="mt-1 text-muted">
              Project conventions: {preview.plan.conventions.join(' · ')}
            </p>
          ) : null}
          <ol className="mt-2 flex flex-col gap-1.5">
            {preview.plan.tasks.map((task, index) => (
              <li key={`${task.toolId}-${index}`} className="rounded border border-line bg-panel p-2">
                <p className="font-medium text-ink">{task.agentName}</p>
                <p className="mt-0.5">{briefText(task.description)}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted">Task details</summary>
                  <p className="mt-1 text-muted">
                    Scope: <span className="mono">{task.declaredFileScope.join(', ')}</span>
                    {' · '}
                    {task.dependencies.length === 0
                      ? 'Can start independently'
                      : `Waits for ${task.dependencies.length} earlier task(s)`}
                  </p>
                  <p className="mt-1 text-muted">{task.rationale}</p>
                </details>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn px-3 py-1.5 text-xs"
              onClick={() => void generatePlan()}
              disabled={busy !== null}
              data-testid="regenerate-workflow"
            >
              Regenerate plan
            </button>
            <button
              type="button"
              className="btn btn-primary px-3 py-1.5 text-xs"
              onClick={() => void startWorkflow()}
              disabled={
                busy !== null ||
                workflowPaused ||
                !previewToolsReady ||
                settings === null ||
                Boolean(settingsError)
              }
              data-testid="start-workflow"
            >
              {busy === 'start' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Start workflow
            </button>
          </div>
        </div>
      ) : !compact ? (
        <button
          type="button"
          className="btn btn-primary w-fit px-3 py-1.5 text-xs"
          onClick={() => void generatePlan()}
          disabled={
            busy !== null ||
            !selectedProject ||
            selectedProject.pathStatus !== 'ok' ||
            launchableTools.length === 0 ||
            settings === null ||
            Boolean(settingsError) ||
            prompt.trim().length < 8
          }
          data-testid="generate-workflow"
        >
          {busy === 'preview' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Generate workflow
        </button>
      ) : null}

      {activeWorkflow ? (
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11px]" data-testid="workflow-progress">
          <p className="font-medium text-ink">
            {needsAttention
              ? 'Needs your attention'
              : workflowPaused
                ? 'Workflow paused'
                : orchestration?.sharedFolderRisk
                  ? 'Safe workspaces required'
                  : `Workflow ${workflowStatus(activeWorkflow)}`}
            {' · '}
            {activeWorkflow.workflow.plan.tasks.length} agent task(s)
          </p>
          <p className="mt-0.5 text-muted">
            {runningCount} working · {queuedCount} queued · {waitingCount} waiting ·{' '}
            {validatingCount} checking changes · {integrationCount} ready for review ·{' '}
            {completedCount} completed · {failedCount} need attention ·{' '}
            {cancelledCount} cancelled
          </p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {tasks.map((task) => {
              const terminal = session?.terminals.find((entry) => entry.id === task.id);
              const failedTerminal =
                terminal?.status === 'error' || terminal?.status === 'unavailable';
              return (
                <li
                  key={task.id}
                  className={`rounded border px-2 py-1.5 ${
                    task.state === 'failed' || failedTerminal
                      ? 'border-danger bg-danger-soft'
                      : 'border-line bg-panel'
                  }`}
                >
                  <p className="font-medium text-ink">
                    {taskTitle(task.description) || task.agentName}
                  </p>
                  <p className="mt-0.5 text-muted">
                    {briefText(
                      task.completionSummary ??
                        task.blockedReason ??
                        terminal?.lastError ??
                        (failedTerminal || task.state === 'failed'
                          ? 'This task stopped before completion and needs attention.'
                          : task.state === 'integrated'
                            ? 'The changes were integrated successfully.'
                            : task.state === 'awaiting_integration'
                              ? 'Validation finished; changes are ready for review.'
                              : task.state === 'validating'
                                ? 'Configured checks are running.'
                                : terminal?.status === 'running'
                                  ? 'The agent is working on its assigned changes.'
                                  : task.waitKind === 'files'
                                    ? 'Waiting for a file another agent is using.'
                                    : task.waitKind === 'dependency'
                                      ? 'Waiting for another task to finish.'
                                      : 'This task has not started yet.'),
                    )}
                  </p>
                  <p className="text-muted">
                    {terminal?.toolName ?? task.agentName} ·{' '}
                    {failedTerminal ? 'Needs your attention' : taskStateLabel(task)}
                  </p>
                  {task.waitKind ? (
                    <p className="mt-0.5 text-muted">
                      {task.waitKind === 'dependency'
                        ? 'Waiting for another task to finish.'
                        : 'Waiting for a file another agent is using.'}
                    </p>
                  ) : null}
                  {task.state === 'failed' || failedTerminal ? (
                    <p className="mt-0.5 text-danger">
                      {briefText(terminal?.lastError ?? task.blockedReason ?? task.integrationReason ?? 'The agent needs attention.')}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {workflowPaused ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-warn">No new tasks will start until scheduling resumes.</span>
              <button
                type="button"
                className="btn px-2.5 py-1 text-xs"
                onClick={() => void resumeWorkflow()}
                disabled={busy !== null}
                data-testid="resume-workflow"
              >
                {busy === 'resume' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Resume Workflow
              </button>
            </div>
          ) : null}
          {statusError ? (
            <p role="status" className="mt-1 text-warn">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Showing last confirmed status: {statusError}
            </p>
          ) : null}
        </div>
      ) : null}

      {orchestration?.sharedFolderRisk ? (
        <p className="rounded border border-line bg-warn-soft px-2.5 py-2 text-[11px] text-warn">
          This session shares one folder, so concurrent agent tasks are blocked. Stop its terminals,
          then open Advanced Details to convert it to isolated worktrees; your files will not be
          moved or deleted.{' '}
          <a className="underline" href="#task-orchestration-details">
            Open conversion steps
          </a>
        </p>
      ) : null}

      {workflowPaused && !activeWorkflow ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-warn">
          <span>Scheduling is paused for this project.</span>
          <button
            type="button"
            className="btn px-2.5 py-1 text-xs"
            onClick={() => void resumeWorkflow()}
            disabled={busy !== null}
            data-testid="resume-workflow"
          >
            {busy === 'resume' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Resume Workflow
          </button>
        </div>
      ) : null}

      {!activeWorkflow ? (
        <p
          className={`text-[11px] ${
            launchableTools.length === 0 && tools !== null ? 'text-warn' : 'text-muted'
          }`}
          role="status"
          data-testid="workflow-readiness"
        >
          {busy === 'preview'
            ? 'Checking your project…'
            : busy === 'start'
              ? 'Preparing safe workspaces…'
              : preview
                ? workflowPaused
                  ? 'Plan reviewed; resume scheduling before starting.'
                  : previewToolsReady
                    ? 'Ready to start.'
                    : 'A planned CLI is no longer launch-ready. Regenerate the plan or review CLI setup.'
                : readinessMessage}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg border border-line bg-danger-soft px-3 py-2 text-xs text-ink">
          {error}
        </p>
      ) : null}
    </section>
  );
}
