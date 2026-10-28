import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/types';
import { ApiError, sendApiError } from '../errors';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
} from '../services/projects';

const createSchema = z
  .object({
    path: z.string().min(1, 'Enter a folder path.').max(4096, 'The folder path is too long.'),
    name: z.string().trim().min(1, 'Project name cannot be empty.').max(80, 'Project name is too long.').optional(),
  })
  .strict();

const renameSchema = z
  .object({
    name: z.string().trim().min(1, 'Project name cannot be empty.').max(80, 'Project name is too long.'),
  })
  .strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'invalid_request',
      parsed.error.issues[0]?.message ?? 'Invalid request.',
    );
  }
  return parsed.data;
}

export function createProjectsRouter(db: Db): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    try {
      const query = typeof req.query.q === 'string' ? req.query.q : '';
      res.json({ projects: await listProjects(db, query) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.post('/', async (req, res) => {
    try {
      const input = parseBody(createSchema, req.body);
      const project = await createProject(db, input);
      res.status(201).json({ project });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.json({ project: await getProject(db, req.params.id) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const input = parseBody(renameSchema, req.body);
      res.json({ project: await renameProject(db, req.params.id, input.name) });
    } catch (error) {
      sendApiError(res, error);
    }
  });

  router.delete('/:id', (req, res) => {
    try {
      deleteProject(db, req.params.id);
      res.status(204).end();
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
