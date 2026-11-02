import { Router } from 'express';
import { z } from 'zod';
import { sendApiError } from '../errors';
import { MAX_ID_LENGTH, MAX_SESSION_TITLE_LENGTH } from '../limits';
import type { SessionService } from '../services/sessions';
import { idSchema } from './idSchema';
import { parseBody } from './parseBody';

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
        .array(
          z
            .object({
              toolId: z.string().trim().min(1).max(MAX_ID_LENGTH),
              description: z.string().max(4000).optional(),
              declaredFileScope: z
                .array(z.string().max(512))
                .max(100)
                .optional(),
              dependencies: z
                .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
                .max(32)
                .optional(),
            })
            .strict(),
        )
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
      const id = parseBody(idSchema, req.params.id);
      res.json({ session: service.get(id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/open', (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      res.json({ session: service.markOpened(id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/terminals', async (req, res) => {
    try {
      const sessionId = parseBody(idSchema, req.params.id);
      const input = parseBody(
        z
          .object({
            toolId: z.string().trim().min(1).max(MAX_ID_LENGTH),
            workspaceMode: z.enum(['shared', 'isolated']).optional(),
            task: z
              .object({
                description: z.string().max(4000).optional(),
                declaredFileScope: z
                  .array(z.string().max(512))
                  .max(100)
                  .optional(),
                dependencies: z
                  .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
                  .max(32)
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
        req.body,
      );
      const session = await service.addTerminal(sessionId, input);
      res.status(201).json({ session });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.patch('/:sessionId/terminals/:terminalId/task', (req, res) => {
    try {
      const sessionId = parseBody(idSchema, req.params.sessionId);
      const terminalId = parseBody(idSchema, req.params.terminalId);
      const input = parseBody(
        z
          .object({
            description: z.string().max(4000).optional(),
            declaredFileScope: z
              .array(z.string().max(512))
              .max(100)
              .optional(),
            dependencies: z
              .array(z.string().trim().min(1).max(MAX_ID_LENGTH))
              .max(32)
              .optional(),
            status: z
              .enum([
                'unassigned',
                'planned',
                'in_progress',
                'completed',
                'failed',
                'cancelled',
              ])
              .optional(),
          })
          .strict(),
        req.body,
      );
      const session = service.updateTask(
        sessionId,
        terminalId,
        input,
      );
      res.json({ session });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/stop', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      res.json({ session: await service.stopSession(id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/start', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      res.json(await service.startAllTerminals(id));
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/commit-push', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      const input = parseBody(
        z
          .object({
            message: z.string().trim().min(1).max(500),
          })
          .strict(),
        req.body,
      );
      const result = await service.commitAndPush(id, input.message);
      res.json(result);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      await service.deleteSession(id);
      res.status(204).end();
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:sessionId/terminals/:terminalId/stop', async (req, res) => {
    try {
      const sessionId = parseBody(idSchema, req.params.sessionId);
      const terminalId = parseBody(idSchema, req.params.terminalId);
      res.json({
        session: await service.stopTerminal(terminalId, sessionId),
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:sessionId/terminals/:terminalId/restart', async (req, res) => {
    try {
      const sessionId = parseBody(idSchema, req.params.sessionId);
      const terminalId = parseBody(idSchema, req.params.terminalId);
      res.json({
        session: await service.restartTerminal(terminalId, sessionId),
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
