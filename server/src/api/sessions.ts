import { Router } from 'express';
import { z } from 'zod';
import { MAX_ID_LENGTH, MAX_SESSION_TITLE_LENGTH } from '../limits';
import type { SessionService } from '../services/sessions';
import { parseBody } from './parseBody';

const taskFields = {
  description: z.string().max(4000).optional(),
  declaredFileScope: z
    .array(z.string().max(512))
    .max(100)
    .optional(),
  dependencies: z
    .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
    .max(32)
    .optional(),
};

const taskInputSchema = z.object(taskFields).strict();

const createTaskInputSchema = z
  .object({
    toolId: z.string().trim().min(1).max(MAX_ID_LENGTH),
    ...taskFields,
  })
  .strict();

const updateTaskInputSchema = z
  .object({
    ...taskFields,
    status: z
      .enum(['unassigned', 'planned', 'in_progress', 'completed', 'failed', 'cancelled'])
      .optional(),
  })
  .strict();

function createSessionSchema(maxTerminalsPerSession: number) {
  return z
    .object({
      projectId: z.string().trim().min(1, 'Select a project.').max(MAX_ID_LENGTH),
      mode: z.enum(['quick', 'custom']),
      workspaceMode: z.enum(['shared', 'isolated']).optional(),
      toolIds: z
        .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
        .max(maxTerminalsPerSession, 'Too many CLI profiles selected.')
        .optional(),
      tasks: z
        .array(createTaskInputSchema)
        .max(maxTerminalsPerSession)
        .optional(),
      title: z
        .string()
        .trim()
        .min(1, 'Session title cannot be empty.')
        .max(MAX_SESSION_TITLE_LENGTH)
        .optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.mode === 'quick' && value.toolIds && value.toolIds.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['toolIds'],
          message: 'Quick Start does not accept a CLI profile selection.',
        });
      }
      if (value.mode === 'custom' && (!value.toolIds || value.toolIds.length === 0)) {
        context.addIssue({
          code: 'custom',
          path: ['toolIds'],
          message: 'Select at least one CLI profile.',
        });
      }
      if (value.toolIds && new Set(value.toolIds).size !== value.toolIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['toolIds'],
          message: 'Duplicate CLI profiles are not allowed.',
        });
      }
    });
}

export function createSessionsRouter(service: SessionService): Router {
  const router = Router();
  const createSessionSchemaWithLimit = createSessionSchema(service.maxTerminalsPerSession);

  router.get('/', (_req, res) => {
    res.json({ sessions: service.list() });
  });

  router.post('/', async (req, res) => {
    const session = await service.create(
      parseBody(createSessionSchemaWithLimit, req.body),
    );
    res.status(201).json({ session });
  });

  router.get('/:id', (req, res) => {
    const session = service.get(req.params.id);
    // Ownership check: in local-first single-user mode, any valid token holder
    // may access sessions. For multi-user, add: if (session.userId !== req.user?.id) { ... }
    res.json({ session });
  });

  router.post('/:id/open', (req, res) => {
    res.json({ session: service.markOpened(req.params.id) });
  });

  router.post('/:id/terminals', async (req, res) => {
    const input = parseBody(
      z
        .object({
          toolId: z.string().trim().min(1).max(MAX_ID_LENGTH),
          workspaceMode: z.enum(['shared', 'isolated']).optional(),
          task: taskInputSchema.optional(),
        })
        .strict(),
      req.body,
    );
    const session = await service.addTerminal(req.params.id, input);
    res.status(201).json({ session });
  });

  router.patch('/:sessionId/terminals/:terminalId/task', (req, res) => {
    const input = parseBody(updateTaskInputSchema, req.body);
    const session = service.updateTask(
      req.params.sessionId,
      req.params.terminalId,
      input,
    );
    res.json({ session });
  });

  router.post('/:id/stop', async (req, res) => {
    res.json({ session: await service.stopSession(req.params.id) });
  });

  router.post('/:id/start', async (req, res) => {
    res.json(await service.startAllTerminals(req.params.id));
  });

  router.post('/:id/commit-push', async (req, res) => {
    const input = parseBody(
      z
        .object({
          message: z.string().trim().min(1).max(500),
        })
        .strict(),
      req.body,
    );
    const result = await service.commitAndPush(req.params.id, input.message);
    res.json(result);
  });

  router.delete('/:id', async (req, res) => {
    await service.deleteSession(req.params.id);
    res.status(204).end();
  });

  router.post('/:sessionId/terminals/:terminalId/stop', async (req, res) => {
    res.json({
      session: await service.stopTerminal(req.params.terminalId, req.params.sessionId),
    });
  });

  router.post('/:sessionId/terminals/:terminalId/restart', async (req, res) => {
    res.json({
      session: await service.restartTerminal(req.params.terminalId, req.params.sessionId),
    });
  });

  return router;
}
