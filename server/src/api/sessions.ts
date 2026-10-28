import { Router } from 'express';
import { z } from 'zod';
import { ApiError, sendApiError } from '../errors';
import { MAX_TERMINALS_PER_SESSION, type SessionService } from '../services/sessions';

const createSessionSchema = z
  .object({
    projectId: z.string().trim().min(1, 'Select a project.').max(100),
    mode: z.enum(['quick', 'custom']),
    toolIds: z
      .array(z.string().trim().min(1).max(100))
      .max(MAX_TERMINALS_PER_SESSION, 'Too many CLI profiles selected.')
      .optional(),
    title: z.string().trim().min(1, 'Session title cannot be empty.').max(120).optional(),
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

function parseCreateBody(body: unknown): z.infer<typeof createSessionSchema> {
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues[0]?.message ?? 'Invalid request.',
    );
  }
  return parsed.data;
}

export function createSessionsRouter(service: SessionService): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ sessions: service.list() });
  });

  router.post('/', async (req, res) => {
    try {
      const session = await service.create(parseCreateBody(req.body));
      res.status(201).json({ session });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.get('/:id', (req, res) => {
    try {
      res.json({ session: service.get(req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/open', (req, res) => {
    try {
      res.json({ session: service.markOpened(req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      res.json({ session: await service.stopSession(req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:sessionId/terminals/:terminalId/stop', async (req, res) => {
    try {
      res.json({
        session: await service.stopTerminal(req.params.terminalId, req.params.sessionId),
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:sessionId/terminals/:terminalId/restart', async (req, res) => {
    try {
      res.json({
        session: await service.restartTerminal(req.params.terminalId, req.params.sessionId),
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
