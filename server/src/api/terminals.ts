import { Router } from 'express';
import { sendApiError } from '../errors';
import type { SessionService } from '../services/sessions';

export function createTerminalsRouter(service: SessionService): Router {
  const router = Router();

  router.post('/:id/stop', async (req, res) => {
    try {
      res.json({ session: await service.stopTerminal(req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/:id/restart', async (req, res) => {
    try {
      res.json({ session: await service.restartTerminal(req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
