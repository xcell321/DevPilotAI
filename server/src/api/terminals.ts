import { Router } from 'express';
import { sendApiError } from '../errors';
import type { SessionService } from '../services/sessions';
import { idSchema } from './idSchema';
import { parseBody } from './parseBody';

export function createTerminalsRouter(service: SessionService): Router {
  const router = Router();

  router.post('/:id/stop', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      res.json({ session: await service.stopTerminal(id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/restart', async (req, res) => {
    try {
      const id = parseBody(idSchema, req.params.id);
      res.json({ session: await service.restartTerminal(id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
