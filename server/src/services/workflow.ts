import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  OrchestrationSettings,
  SessionSummary,
  WorkflowPlanSummary,
  WorkflowSummary,
  WorkflowTaskPlan,
} from '../../../shared/api-types.cjs';
import type { Db } from '../db/types';
import { ApiError } from '../errors';
import { DEFAULT_INTEGRATION_BRANCH } from './orchestration';
import type { OrchestrationService } from './orchestration';
import type { SessionService } from './sessions';
import { inspectGitRepository, runGitCommand } from './gitWorkspaces';

const MAX_PROMPT_LENGTH = 4000;
const MIN_PROMPT_LENGTH = 8;
const MAX_GENERATED_TASKS = 4;
const MAX_INSPECTED_FILES = 3000;

interface ProjectRow {
  id: string;
  name: string;
  path: string;
}

interface ToolChoice {
  id: string;
  displayName: string;
}

interface RepositoryView {
  repositoryRoot: string;
  projectRelativePath: string;
  files: string[];
  directories: Array<{ path: string; files: number }>;
  extensions: Map<string, number>;
  conventions: string[];
}

const AREA_RULES: Array<{ area: string; words: RegExp; directory: RegExp }> = [
  {
    area: 'backend',
    words: /\b(server|backend|api|endpoint|database|migration|auth|service|orchestrat)/i,
    directory: /^(server|backend|api|services?)$/i,
  },
  {
    area: 'frontend',
    words: /\b(ui|frontend|web|component|page|style|css|react|screen|layout|panel)/i,
    directory: /^(web|frontend|client|ui|app|apps)$/i,
  },
  {
    area: 'tests',
    words: /\b(test|spec|coverage|fixture)/i,
    directory: /^(tests?|__tests__|specs?)$/i,
  },
  {
    area: 'docs',
    words: /\b(docs?|documentation|readme|guide)/i,
    directory: /^(docs?|documentation)$/i,
  },
];

const FILE_TOKEN = /(?:^|[\s"'`(])([\w@./-]+\.(?:tsx?|jsx?|mjs|cjs|css|scss|json|md|py|go|rs|java|kt|rb|php|html|sql|ya?ml))(?=$|[\s"'`),.;:])/gi;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task'
  );
}

function isWithin(parent: string, child: string): boolean {
  const left = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const right = process.platform === 'win32' ? child.toLowerCase() : child;
  return left === right || right.startsWith(`${left}/`);
}

function scopesConflict(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

/**
 * Turns one high-level instruction into a persisted, reviewable task plan by
 * inspecting the project's tracked files, conventions and available verified
 * CLI profiles. The planner is deterministic: no external model is required,
 * and every generated scope is verified to be non-overlapping.
 */
export class WorkflowService {
  private readonly startingPlans = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly orchestration: OrchestrationService,
  ) {}

  async preview(input: {
    projectId: string;
    prompt: string;
    maxTasks?: number;
  }): Promise<{ plan: WorkflowPlanSummary; planFingerprint: string }> {
    const prepared = await this.preparePlan(input);
    return {
      plan: prepared.plan,
      planFingerprint: prepared.planFingerprint,
    };
  }

  async generate(input: {
    projectId: string;
    prompt: string;
    maxTasks?: number;
    planFingerprint: string;
  }): Promise<{
    workflow: WorkflowSummary;
    session: SessionSummary;
    plan: WorkflowPlanSummary;
    schedule: { scheduled: string[]; skipped: Array<{ taskId: string; reason: string }> };
  }> {
    // A double click, an impatient retry or two simultaneous requests must not
    // create two sessions for the same reviewed plan. The mark is taken before
    // the first await so the check and the claim cannot interleave.
    const startKey = `${input.projectId}:${input.planFingerprint}`;
    if (this.startingPlans.has(startKey)) {
      throw new ApiError(
        409,
        'workflow_start_in_progress',
        'This reviewed plan is already starting. Wait for the workflow to open instead of starting it twice.',
      );
    }
    this.startingPlans.add(startKey);
    try {
      return await this.startReviewedPlan(input);
    } finally {
      this.startingPlans.delete(startKey);
    }
  }

  private async startReviewedPlan(input: {
    projectId: string;
    prompt: string;
    maxTasks?: number;
    planFingerprint: string;
  }): Promise<{
    workflow: WorkflowSummary;
    session: SessionSummary;
    plan: WorkflowPlanSummary;
    schedule: { scheduled: string[]; skipped: Array<{ taskId: string; reason: string }> };
  }> {
    const { project, prompt, plan, planFingerprint } = await this.preparePlan(input);
    if (input.planFingerprint !== planFingerprint) {
      throw new ApiError(
        409,
        'workflow_plan_changed',
        'The project or available CLI profiles changed after review. Generate and review the plan again before starting.',
      );
    }

    const session = await this.sessions.createOrchestratedSession({
      projectId: project.id,
      title: plan.summary.slice(0, 120),
      tasks: plan.tasks.map((task) => ({
        toolId: task.toolId,
        description: task.description,
        declaredFileScope: task.declaredFileScope,
        dependencies: task.dependencies,
      })),
    });

    const now = new Date().toISOString();
    const workflowId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO workflow_runs (
           id, project_id, session_id, prompt, plan_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(workflowId, project.id, session.id, prompt, JSON.stringify(plan), now, now);

    const schedule = await this.orchestration.scheduleSession(session.id);
    return {
      workflow: {
        id: workflowId,
        projectId: project.id,
        sessionId: session.id,
        prompt,
        status: 'running',
        plan,
        createdAt: now,
        updatedAt: now,
      },
      session: this.sessions.get(session.id),
      plan,
      schedule: {
        scheduled: schedule.scheduled,
        skipped: schedule.skipped,
      },
    };
  }

  private async preparePlan(input: {
    projectId: string;
    prompt: string;
    maxTasks?: number;
  }): Promise<{
    project: ProjectRow;
    prompt: string;
    plan: WorkflowPlanSummary;
    planFingerprint: string;
  }> {
    const project = this.requireProject(input.projectId);
    const prompt = input.prompt.trim();
    if (prompt.length < MIN_PROMPT_LENGTH || prompt.length > MAX_PROMPT_LENGTH) {
      throw new ApiError(
        400,
        'invalid_workflow_prompt',
        `Describe the workflow in ${MIN_PROMPT_LENGTH}-${MAX_PROMPT_LENGTH} characters so tasks can be planned.`,
      );
    }
    const requestedTasks = input.maxTasks ?? 3;
    if (!Number.isInteger(requestedTasks) || requestedTasks < 1 || requestedTasks > MAX_GENERATED_TASKS) {
      throw new ApiError(
        400,
        'invalid_workflow_tasks',
        `A workflow can generate between 1 and ${MAX_GENERATED_TASKS} tasks.`,
      );
    }
    if (this.sessions.maxTerminalsPerSession < 1) {
      throw new ApiError(409, 'terminal_limit', 'This backend cannot create workflow terminals.');
    }

    const tools = this.verifiedTools();
    if (tools.length === 0) {
      throw new ApiError(
        409,
        'no_verified_agent',
        'No launch-verified CLI profile is available. Verify a CLI profile before generating a workflow.',
      );
    }

    const repository = await this.inspectProject(project);
    const maxTasks = Math.min(
      requestedTasks,
      MAX_GENERATED_TASKS,
      this.sessions.maxTerminalsPerSession,
    );
    const plan = this.buildPlan(project, prompt, repository, tools, maxTasks);
    const planFingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ projectId: project.id, prompt, plan }))
      .digest('hex');
    return { project, prompt, plan, planFingerprint };
  }

  setPaused(projectId: string, paused: boolean): OrchestrationSettings {
    const settings = this.orchestration.updateSettings(projectId, { schedulingPaused: paused });
    this.db
      .prepare(
        `UPDATE workflow_runs SET status = ?, updated_at = ?
         WHERE project_id = ? AND status IN ('running', 'paused')`,
      )
      .run(paused ? 'paused' : 'running', new Date().toISOString(), projectId);
    return settings;
  }

  private requireProject(projectId: string): ProjectRow {
    const row = this.db
      .prepare('SELECT id, name, path FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    if (!row) throw new ApiError(404, 'project_not_found', 'Project not found.');
    return row;
  }

  private verifiedTools(): ToolChoice[] {
    return this.db
      .prepare(
        `SELECT id, display_name AS displayName
         FROM tool_profiles
         WHERE enabled = 1 AND launch_verified = 1 AND last_status = 'available'
         ORDER BY default_on_quick_start DESC, display_name`,
      )
      .all() as ToolChoice[];
  }

  private async inspectProject(project: ProjectRow): Promise<RepositoryView> {
    const snapshot = await inspectGitRepository(project.path);
    const listed = await runGitCommand(snapshot.repositoryRoot, [
      '-c',
      'core.quotepath=false',
      'ls-files',
      '-z',
    ]);
    if (listed.code !== 0) {
      throw new ApiError(
        409,
        'workflow_inspection_failed',
        'The project file list could not be read for workflow planning.',
      );
    }
    const relativeProject = snapshot.projectRelativePath.replace(/\\/g, '/');
    const prefix = relativeProject === '' || relativeProject === '.' ? '' : `${relativeProject}/`;
    const files = listed.stdout
      .split('\u0000')
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, '/'))
      .filter((file) => prefix === '' || file.startsWith(prefix))
      .map((file) => (prefix === '' ? file : file.slice(prefix.length)))
      .filter((file) => !file.startsWith('.git/'))
      .slice(0, MAX_INSPECTED_FILES);

    const directoryCounts = new Map<string, number>();
    const extensions = new Map<string, number>();
    for (const file of files) {
      const segments = file.split('/');
      if (segments.length > 1) {
        const top = segments[0]!;
        directoryCounts.set(top, (directoryCounts.get(top) ?? 0) + 1);
      }
      const extension = path.extname(file).toLowerCase();
      if (extension) extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    }

    const conventions: string[] = [];
    const packageJsonPath = path.join(project.path, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
          scripts?: Record<string, string>;
        };
        const scripts = Object.keys(manifest.scripts ?? {});
        conventions.push(
          scripts.length > 0
            ? `npm scripts: ${scripts.slice(0, 8).join(', ')}`
            : 'npm project without scripts',
        );
      } catch {
        conventions.push('unreadable package.json');
      }
    }
    for (const file of ['tsconfig.json', 'eslint.config.js', 'vitest.config.ts', 'README.md']) {
      if (fs.existsSync(path.join(project.path, file))) conventions.push(`contains ${file}`);
    }
    const topExtensions = [...extensions.entries()]
      .sort((first, second) => second[1] - first[1])
      .slice(0, 3)
      .map(([extension, count]) => `${extension} (${count})`);
    if (topExtensions.length > 0) conventions.push(`file types: ${topExtensions.join(', ')}`);
    if (files.length === 0) conventions.push('no tracked files yet');

    return {
      repositoryRoot: snapshot.repositoryRoot,
      projectRelativePath: relativeProject,
      files,
      directories: [...directoryCounts.entries()]
        .map(([dir, count]) => ({ path: dir, files: count }))
        .sort((first, second) => second.files - first.files),
      extensions,
      conventions,
    };
  }

  private buildPlan(
    project: ProjectRow,
    prompt: string,
    repository: RepositoryView,
    tools: ToolChoice[],
    maxTasks: number,
  ): WorkflowPlanSummary {
    const clauses = this.splitPrompt(prompt);
    const selected = clauses.slice(0, maxTasks);
    const assignments: Array<{ description: string; area: string; scopes: string[] }> = [];

    for (const [index, clause] of selected.entries()) {
      const plan = this.planClause(clause, repository);
      const explicit = plan.files.filter(
        (file) => !assignments.some((entry) => entry.scopes.some((scope) => scopesConflict(scope, file))),
      );
      let scopes = explicit;
      if (scopes.length === 0) {
        const directory = plan.directories.find(
          (candidate) =>
            !assignments.some((entry) =>
              entry.scopes.some((scope) => scopesConflict(scope, candidate)),
            ),
        );
        if (directory) scopes = [directory];
      }

      if (scopes.length === 0) {
        // The clause reuses another task's files or directory. Merge it into
        // that task instead of creating overlapping ownership.
        const target =
          assignments.find((entry) => entry.area === plan.area) ?? assignments[assignments.length - 1];
        if (target) {
          target.description = `${target.description.replace(/\s*$/, '')} Also: ${clause}.`;
          continue;
        }
        scopes = [this.freshFilePath(clause, index, repository)];
      }
      assignments.push({
        description: this.describeClause(clause, plan.area, scopes),
        area: plan.area,
        scopes,
      });
    }

    if (assignments.length === 0) {
      assignments.push({
        description: this.describeClause(prompt, 'general', [`src/${slugify(prompt)}.ts`]),
        area: 'general',
        scopes: [`src/${slugify(prompt)}.ts`],
      });
    }

    const tasks: WorkflowTaskPlan[] = assignments.map((assignment, index) => {
      const previous = assignments.slice(0, index);
      const dependencies = this.planDependencies(assignment.description, assignment.area, previous);
      const tool = tools[index % tools.length]!;
      return {
        toolId: tool.id,
        agentName: tool.displayName,
        description: assignment.description,
        declaredFileScope: assignment.scopes,
        dependencies,
        rationale: this.planRationale(
          assignment.area,
          assignment.scopes,
          dependencies,
          previous.map((entry) => entry.scopes[0] ?? ''),
        ),
      };
    });

    return {
      summary: `${tasks.length} coordinated task(s) for “${prompt.slice(0, 110)}” in ${
        project.name
      } · isolated worktrees · target ${DEFAULT_INTEGRATION_BRANCH}`,
      conventions: [
        ...repository.conventions,
        ...(repository.directories.length > 0
          ? [`top directories: ${repository.directories.slice(0, 5).map((dir) => dir.path).join(', ')}`]
          : []),
      ],
      tasks,
    };
  }

  private freshFilePath(clause: string, index: number, repository: RepositoryView): string {
    const extension =
      repository.extensions.has('.py') && !repository.extensions.has('.ts') ? 'py' : 'ts';
    return `workflow-${String(index + 1).padStart(2, '0')}/${slugify(clause)}.${extension}`;
  }

  private splitPrompt(prompt: string): string[] {
    const raw = prompt
      .split(/\r?\n|;|(?:\bthen\b)/i)
      .flatMap((line) => line.split(/\s*,\s*(?=[a-z])/i))
      .map((clause) => clause.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((clause) => clause.split(/\s+/).length >= 2);
    const unique = uniqueStrings(raw);
    return unique.length > 0 ? unique : [prompt];
  }

  private planClause(
    clause: string,
    repository: RepositoryView,
  ): { files: string[]; directories: string[]; area: string } {
    const files = uniqueStrings(
      [...clause.matchAll(FILE_TOKEN)]
        .map((match) => match[1]!.replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(
          (file) =>
            !file.startsWith('/') &&
            !/^[a-zA-Z]:/.test(file) &&
            !file.split('/').includes('..'),
        ),
    );

    let area = 'general';
    for (const rule of AREA_RULES) {
      if (rule.words.test(clause)) {
        area = rule.area;
        break;
      }
    }

    const rule = AREA_RULES.find((candidate) => candidate.area === area);
    const all = repository.directories
      .map((entry) => entry.path)
      .filter((directory) => !/^(node_modules|dist|build|\.git)$/i.test(directory));
    const preferred = rule ? all.filter((directory) => rule.directory.test(directory)) : [];
    const directories = uniqueStrings([...preferred, ...all]);
    return { files, directories, area };
  }

  private planDependencies(
    clause: string,
    area: string,
    previous: Array<{ scopes: string[] }>,
  ): number[] {
    if (previous.length === 0) return [];
    const last = previous.length - 1;
    if (/\b(after|then|based on|depends? on|uses?|consume|import|integrat)/i.test(clause)) {
      return [last];
    }
    const backend = previous.findIndex((task) =>
      /^(server|backend|api|services?)\b/i.test(task.scopes[0] ?? ''),
    );
    if (area === 'frontend' && backend >= 0) return [backend];
    if (area === 'tests' || area === 'docs') {
      return [...new Set(previous.map((_task, index) => index))];
    }
    return [];
  }

  private describeClause(clause: string, area: string, scopes: string[]): string {
    const text = clause.replace(/\s+/g, ' ').trim();
    const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
    return `${capitalized} (${area} work in ${scopes.join(', ')}). Commit the changes on the task branch and report what was completed.`;
  }

  private planRationale(
    area: string,
    scopes: string[],
    dependencies: number[],
    previousScopes: string[],
  ): string {
    const dependencyNote =
      dependencies.length === 0
        ? 'Independent work; can run in parallel with other independent tasks.'
        : `Waits for ${dependencies
            .map((index) => previousScopes[index] ?? `task ${index + 1}`)
            .join(', ')} to integrate first.`;
    return `${area} area mapped to ${scopes.join(', ')}. ${dependencyNote}`;
  }
}
