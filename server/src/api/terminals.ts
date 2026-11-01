import { Router } from 'express';
import type { SessionService } from '../services/sessions';

export function createTerminalsRouter(service: SessionService): Router {
  const router = Router();

  router.post('/:id/stop', async (req, res) => {
    res.json({ session: await service.stopTerminal(req.params.id) });
  });

  router.post('/:id/restart', async (req, res) => {
    res.json({ session: await service.restartTerminal(req.params.id) });
  });

  return router;
}
