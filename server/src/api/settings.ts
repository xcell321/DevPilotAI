import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/types';
import { ApiError, sendApiError } from '../errors';
import {
  getWorkspacePreferences,
  updateWorkspacePreferences,
  WORKSPACE_PREFERENCES_VERSION,
} from '../services/workspacePreferences';

const idSchema = z.string().trim().min(1).max(100).nullable();

const workspacePreferencesSchema = z
  .object({
    version: z.literal(WORKSPACE_PREFERENCES_VERSION),
    selectedProjectId: idSchema.optional(),
    selectedSessionId: idSchema.optional(),
    maximizedTerminalId: idSchema.optional(),
    terminalLayout: z.enum(['auto', 'single']).optional(),
  })
  .strict();

function parseBody(body: unknown): z.infer<typeof workspacePreferencesSchema> {
  const parsed = workspacePreferencesSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_settings',
      parsed.error.issues[0]?.message ?? 'Invalid workspace preferences.',
    );
  }
  return parsed.data;
}

export function createSettingsRouter(db: Db): Router {
  const router = Router();

  router.get('/workspace', (_req, res) => {
    res.json({ preferences: getWorkspacePreferences(db) });
  });

  router.patch('/workspace', (req, res) => {
    try {
      const input = parseBody(req.body);
      res.json({ preferences: updateWorkspacePreferences(db, input) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
