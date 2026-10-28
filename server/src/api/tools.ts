import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/types';
import { ApiError, sendApiError } from '../errors';
import {
  getToolProfile,
  listToolProfiles,
  updateToolCheck,
} from '../services/toolRegistry';
import { probeExecutable } from '../services/toolProbe';
import { verifiedProbeArgs } from '../services/toolCatalog';

// Shape for a future POST /api/tools endpoint. No shell field is accepted.
export const toolProfileCreateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    executable: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine(
        (value) => /^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\'),
        'Executable must be an absolute local drive path.',
      ),
    fixedArgs: z.array(z.string().trim().min(1).max(512)).max(32).default([]),
  })
  .strict();

export function createToolsRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ tools: listToolProfiles(db) });
  });

  router.post('/:id/check', async (req, res) => {
    try {
      const tool = getToolProfile(db, req.params.id);
      if (!tool) {
        throw new ApiError(404, 'tool_not_found', 'CLI profile not found.');
      }

      if (!tool.command) {
        res.json({
          tool,
          check: {
            status: 'unconfigured',
            checkedAt: null,
            message: 'No executable is configured. No process was started.',
          },
        });
        return;
      }

      const probeArgs = verifiedProbeArgs(tool.id);
      if (!probeArgs) {
        const checkedAt = new Date().toISOString();
        updateToolCheck(db, tool.id, 'unknown', checkedAt);
        res.json({
          tool: getToolProfile(db, tool.id),
          check: {
            status: 'unknown',
            checkedAt,
            message: 'No verified non-interactive probe is available for this profile.',
          },
        });
        return;
      }

      const result = await probeExecutable(tool.command, probeArgs);
      updateToolCheck(db, tool.id, result.status, result.checkedAt);

      res.json({
        tool: getToolProfile(db, tool.id),
        check: {
          status: result.status,
          checkedAt: result.checkedAt,
          output: result.output,
        },
      });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
