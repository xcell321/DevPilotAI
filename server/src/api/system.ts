import { Router } from 'express';
import { pickFolder } from '../services/folderPicker';

export function createSystemRouter(): Router {
  const router = Router();

  router.post('/pick-folder', async (_req, res) => {
    const selectedPath = await pickFolder();
    res.json({ path: selectedPath });
  });

  return router;
}
