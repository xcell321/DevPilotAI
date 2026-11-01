import { ChevronDown, ChevronUp, Loader2, Play, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { LIVE_POLL_INTERVAL_MS } from '../lib/constants';
import { Notice } from './Notice';
import { WorkflowPlanPreview } from './WorkflowPlanPreview';
import { WorkflowProgressDashboard } from './WorkflowProgressDashboard';
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

const READY_MESSAGE = 'Ready to start';

const COMPOSER_GUIDE =
  'Choose a project and describe the outcome. DevPilot plans isolated tasks for available, ' +
  'launch-verified CLI profiles; review the plan before any agent starts.';

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
  const [guideOpen, setGuideOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

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
    const timer = window.setInterval(() => void refresh(), LIVE_POLL_INTERVAL_MS);
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
        sessionId: session?.id,
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
        sessionId: session?.id,
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
                  : READY_MESSAGE;
  const readinessText =
    busy === 'preview'
      ? 'Checking your project…'
      : busy === 'start'
        ? 'Preparing safe workspaces…'
        : preview
          ? workflowPaused
            ? 'Plan reviewed; resume scheduling before starting.'
            : previewToolsReady
              ? 'Ready to start.'
              : 'A planned CLI is no longer launch-ready. Regenerate the plan or review CLI setup.'
          : readinessMessage;
  const readinessOk = readinessText.startsWith('Ready to start');

  return (
    <section
      className={`flex shrink-0 flex-col ${compact ? 'gap-2' : 'gap-3'}`}
      aria-labelledby="workflow-composer-title"
      data-testid="workflow-composer"
    >
      {collapsed && !activeWorkflow ? (
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brass" />
            <span className="eyebrow text-muted">Start an automatic workflow</span>
          </div>
          <button
            type="button"
            className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted hover:text-ink"
            onClick={() => setCollapsed(false)}
            aria-label="Expand workflow composer"
            aria-expanded={false}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            expand
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="workflow-composer-title"
            className="eyebrow flex items-center gap-2 text-muted"
          >
            <Sparkles className="h-3.5 w-3.5 text-brass" />
            {activeWorkflow ? 'Workflow dashboard' : 'Start an automatic workflow'}
          </h2>
          {!compact || guideOpen ? (
            <p className="mt-1 text-[11px] text-muted">{COMPOSER_GUIDE}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] font-medium text-muted hover:text-ink"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse workflow composer"
            aria-expanded={true}
          >
            <ChevronUp className="h-3.5 w-3.5" />
            collapse
          </button>
        {compact ? (
          <button
            type="button"
            className="shrink-0 text-[11px] font-medium text-brass hover:text-brass-hover hover:underline"
            onClick={() => setGuideOpen((open) => !open)}
            aria-expanded={guideOpen}
          >
            How it works
          </button>
        ) : null}
        </div>
      </div>

      {unavailableTools.length > 0 && tools !== null ? (
        <Notice tone="warn">
          <p>
            {unavailableTools.length} enabled CLI profile{unavailableTools.length === 1 ? '' : 's'}{' '}
            need setup.
          </p>
          <p className="mt-0.5 text-muted">
            {unavailableTools
              .map(
                (tool) =>
                  `${tool.displayName} — ${tool.launchReason ?? 'launch verification is required.'}`,
              )
              .join(' · ')}
          </p>
          <Link
            className="mt-0.5 inline-block font-medium text-brass underline underline-offset-2 hover:text-brass-hover"
            to="/tools"
          >
            Review CLI setup
          </Link>
        </Notice>
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
            className="btn btn-brass btn-sm"
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
        <Notice tone="warn">No registered project folder is currently available.</Notice>
      ) : null}

      {preview ? (
        <WorkflowPlanPreview
          plan={preview.plan}
          projectName={selectedProject?.name ?? null}
          busy={busy}
          startDisabled={
            workflowPaused || !previewToolsReady || settings === null || Boolean(settingsError)
          }
          onRegenerate={() => void generatePlan()}
          onStart={() => void startWorkflow()}
        />
      ) : !compact ? (
        <button
          type="button"
          className="btn btn-primary btn-sm w-fit"
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
        <WorkflowProgressDashboard
          summary={activeWorkflow.summary}
          workflow={activeWorkflow.workflow}
          session={session}
          paused={workflowPaused}
          sharedFolderRisk={activeWorkflow.summary.sharedFolderRisk}
          busy={busy !== null}
          statusError={statusError}
          onResume={() => void resumeWorkflow()}
        />
      ) : null}

      {workflowPaused && !activeWorkflow ? (
        <Notice
          tone="warn"
          action={{
            label: 'Resume workflow',
            onClick: () => void resumeWorkflow(),
            disabled: busy !== null,
            icon: Play,
          }}
        >
          Scheduling is paused for this project.
        </Notice>
      ) : null}

      {!activeWorkflow ? (
        <p
          className="flex items-center gap-1.5 text-[11px] text-muted"
          role="status"
          data-testid="workflow-readiness"
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${readinessOk ? 'bg-ok' : 'bg-warn'}`}
            aria-hidden
          />
          {readinessText}
        </p>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      )}
    </section>
  );
}
