import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors';
import { MAX_ID_LENGTH } from '../limits';
import type { OrchestrationService } from '../services/orchestration';
import type { SessionService } from '../services/sessions';
import type { WorkflowService } from '../services/workflow';
import { parseBody } from './parseBody';

const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH);

function taskIdOf(req: Request): string {
  return parseBody(idSchema, req.params.taskId);
}

export function createOrchestrationRouter(
  service: OrchestrationService,
  sessions: SessionService,
  workflows: WorkflowService | null = null,
): Router {
  const router = Router();

  router.get('/settings', (req, res) => {
    const projectId = parseBody(idSchema, req.query.projectId);
    res.json({ settings: service.getSettings(projectId) });
  });

  router.put('/settings', (req, res) => {
    const input = parseBody(
      z
        .object({
          projectId: idSchema,
          autoIntegrate: z.boolean().optional(),
          schedulingPaused: z.boolean().optional(),
          maxConcurrentAgents: z.number().int().min(1).max(1000).optional(),
          targetBranch: z.string().trim().max(200).nullable().optional(),
          validationCommands: z.unknown().optional(),
          protectedPaths: z.unknown().optional(),
        })
        .strict(),
      req.body,
    );
    res.json({
      settings: service.updateSettings(input.projectId, {
        autoIntegrate: input.autoIntegrate,
        schedulingPaused: input.schedulingPaused,
        maxConcurrentAgents: input.maxConcurrentAgents,
        targetBranch: input.targetBranch,
        validationCommands: input.validationCommands,
        protectedPaths: input.protectedPaths,
      }),
    });
  });

  router.get('/sessions/:sessionId', (req, res) => {
    res.json({ orchestration: service.summarizeSession(parseBody(idSchema, req.params.sessionId)) });
  });

  router.post('/sessions/:sessionId/schedule', async (req, res) => {
    const sessionId = parseBody(idSchema, req.params.sessionId);
    service.syncRunningStates();
    const result = await service.scheduleSession(sessionId);
    res.json({ result, orchestration: service.summarizeSession(sessionId) });
  });

  router.post('/sessions/:sessionId/isolate', async (req, res) => {
    const session = await sessions.isolateSession(parseBody(idSchema, req.params.sessionId));
    res.json({
      session,
      orchestration: service.summarizeSession(session.id),
    });
  });

  router.post('/schedule', async (_req, res) => {
    const result = await service.scheduleAll();
    res.json({ result });
  });

  router.post('/queue/process', async (_req, res) => {
    await service.processQueue();
    res.json({ ok: true });
  });

  router.post('/sessions/:sessionId/merge-all', async (req, res) => {
    const result = await service.mergeAll(req.params.sessionId);
    res.json(result);
  });

  router.get('/tasks/:taskId', (req, res) => {
    res.json({
      task: service.getTask(taskIdOf(req)),
      logs: service.taskLogs(taskIdOf(req)),
    });
  });

  router.get('/tasks/:taskId/diff', async (req, res) => {
    res.json(await service.getTaskDiff(taskIdOf(req)));
  });

  router.post('/tasks/:taskId/send-to-terminal', async (req, res) => {
    const input = parseBody(
      z
        .object({
          terminalId: idSchema,
        })
        .strict(),
      req.body,
    );
    const result = await service.sendTaskToTerminal(taskIdOf(req), input.terminalId);
    res.json(result);
  });

  router.post('/tasks/:taskId/complete', async (req, res) => {
    const input = parseBody(
      z.object({ summary: z.string().trim().min(1).max(4000) }).strict(),
      req.body,
    );
    const task = await service.completeTask(taskIdOf(req), input);
    res.json({ task, logs: service.taskLogs(task.id) });
  });

  router.post('/tasks/:taskId/validate', async (req, res) => {
    const task = await service.validateTask(taskIdOf(req));
    res.json({ task, logs: service.taskLogs(task.id) });
  });

  router.post('/tasks/:taskId/cancel', (req, res) => {
    const task = service.cancelTask(taskIdOf(req));
    res.json({ task, logs: service.taskLogs(task.id) });
  });

  router.post('/tasks/:taskId/cancel-validation', (req, res) => {
    const cancelled = service.cancelValidation(taskIdOf(req));
    res.json({ cancelled, task: service.getTask(taskIdOf(req)) });
  });

  router.post('/tasks/:taskId/retry', (req, res) => {
    const task = service.retryTask(taskIdOf(req));
    res.json({ task, logs: service.taskLogs(task.id) });
  });

  router.post('/tasks/:taskId/replan', (req, res) => {
    const input = parseBody(
      z
        .object({
          scopes: z.array(z.string().trim().min(1).max(512)).max(100).optional(),
        })
        .strict(),
      req.body ?? {},
    );
    const task = service.replanTask(taskIdOf(req), input);
    res.json({ task, logs: service.taskLogs(task.id) });
  });

  // Admin endpoints - force release leases and delete task
  router.post('/admin/tasks/:taskId/force-release-leases', (req, res) => {
    const input = parseBody(
      z.object({ reason: z.string().trim().min(1).max(4000) }).strict(),
      req.body,
    );
    const released = service.forceReleaseLeases(taskIdOf(req), input.reason);
    res.json({ released });
  });

  router.delete('/admin/tasks/:taskId', (req, res) => {
    service.deleteTask(taskIdOf(req));
    res.json({ ok: true });
  });

  router.post('/sessions/:sessionId/scheduling', (req, res) => {
    const sessionId = parseBody(idSchema, req.params.sessionId);
    const input = parseBody(
      z.object({ paused: z.boolean() }).strict(),
      req.body ?? {},
    );
    const session = sessions.get(sessionId);
    const settings = service.updateSettings(session.project.id, {
      schedulingPaused: input.paused,
    });
    res.json({ settings, orchestration: service.summarizeSession(sessionId) });
  });

  router.post('/workflows/preview', async (req, res) => {
    if (!workflows) {
      throw new ApiError(
        503,
        'workflow_unavailable',
        'Workflow generation is not configured for this backend.',
      );
    }
    const input = parseBody(
      z
        .object({
          projectId: idSchema,
          prompt: z.string().trim().min(8).max(4000),
          maxTasks: z.number().int().min(1).max(4).optional(),
          sessionId: idSchema.optional(),
          toolId: idSchema.optional(),
          model: z.string().trim().min(1).max(100).optional(),
          skills: z.array(idSchema).max(50).optional(),
        })
        .strict(),
      req.body,
    );
    res.json(await workflows.preview(input));
  });

  router.post('/workflows', async (req, res) => {
    if (!workflows) {
      throw new ApiError(
        503,
        'workflow_unavailable',
        'Workflow generation is not configured for this backend.',
      );
    }
    const input = parseBody(
      z
        .object({
          projectId: idSchema,
          prompt: z.string().trim().min(8).max(4000),
          maxTasks: z.number().int().min(1).max(4).optional(),
          planFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
          sessionId: idSchema.optional(),
          toolId: idSchema.optional(),
          model: z.string().trim().min(1).max(100).optional(),
          skills: z.array(idSchema).max(50).optional(),
        })
        .strict(),
      req.body,
    );
    const result = await workflows.generate(input);
    res.status(201).json({
      ...result,
      orchestration: service.summarizeSession(result.session.id),
    });
  });

  router.get('/workflows/:sessionId', (req, res) => {
    const sessionId = parseBody(idSchema, req.params.sessionId);
    res.json({ orchestration: service.summarizeSession(sessionId) });
  });

  router.post('/tasks/:taskId/integrate', async (req, res) => {
    const options = parseBody(
      z
        .object({
          acknowledgeNoValidation: z.boolean().optional(),
          allowOutOfScope: z.boolean().optional(),
        })
        .strict(),
      req.body ?? {},
    );
    const queued = await service.enqueueIntegration(taskIdOf(req), options);
    await service.processQueue();
    res.json({
      task: service.getTask(queued.id),
      logs: service.taskLogs(queued.id),
    });
  });

  return router;
}
