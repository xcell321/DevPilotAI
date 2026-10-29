import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/types';
import { sendApiError } from '../errors';
import { MAX_ID_LENGTH } from '../limits';
import {
  getWorkspacePreferences,
  updateWorkspacePreferences,
  WORKSPACE_PREFERENCES_VERSION,
} from '../services/workspacePreferences';
import { parseBody } from './parseBody';

const idSchema = z.string().trim().min(1).max(MAX_ID_LENGTH).nullable();

const workspacePreferencesSchema = z
  .object({
    version: z.literal(WORKSPACE_PREFERENCES_VERSION),
    selectedProjectId: idSchema.optional(),
    selectedSessionId: idSchema.optional(),
    maximizedTerminalId: idSchema.optional(),
    terminalLayout: z.enum(['auto', 'single']).optional(),
  })
  .strict();

export function createSettingsRouter(db: Db): Router {
  const router = Router();

  router.get('/workspace', (_req, res) => {
    res.json({ preferences: getWorkspacePreferences(db) });
  });

  router.patch('/workspace', (req, res) => {
    try {
      const input = parseBody(workspacePreferencesSchema, req.body, {
        code: 'invalid_settings',
        message: 'Invalid workspace preferences.',
      });
      res.json({ preferences: updateWorkspacePreferences(db, input) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
