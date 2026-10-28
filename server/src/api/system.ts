import { Router } from 'express';
import { sendApiError } from '../errors';
import { pickFolder } from '../services/folderPicker';

export function createSystemRouter(): Router {
  const router = Router();

  router.post('/pick-folder', async (_req, res) => {
    try {
      const selectedPath = await pickFolder();
      res.json({ path: selectedPath });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
