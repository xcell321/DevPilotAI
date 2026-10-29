import { Router } from 'express';
import { z } from 'zod';
import { sendApiError } from '../errors';
import { MAX_ID_LENGTH, MAX_SESSION_TITLE_LENGTH } from '../limits';
import type { SessionService } from '../services/sessions';
import { parseBody } from './parseBody';

function createSessionSchema(maxTerminalsPerSession: number) {
  return z
    .object({
      projectId: z.string().trim().min(1, 'Select a project.').max(MAX_ID_LENGTH),
      mode: z.enum(['quick', 'custom']),
      toolIds: z
        .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
        .max(maxTerminalsPerSession, 'Too many CLI profiles selected.')
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
    try {
      const session = await service.create(
        parseBody(createSessionSchemaWithLimit, req.body),
      );
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
