import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db/types';
import { sendApiError } from '../errors';
import { MAX_PATH_LENGTH, MAX_PROJECT_NAME_LENGTH } from '../limits';
import {
  cleanupProjectWorktrees,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
} from '../services/projects';
import { parseBody } from './parseBody';

const createSchema = z
  .object({
    path: z
      .string()
      .min(1, 'Enter a folder path.')
      .max(MAX_PATH_LENGTH, 'The folder path is too long.'),
    name: z
      .string()
      .trim()
      .min(1, 'Project name cannot be empty.')
      .max(MAX_PROJECT_NAME_LENGTH, 'Project name is too long.')
      .optional(),
  })
  .strict();

const renameSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Project name cannot be empty.')
      .max(MAX_PROJECT_NAME_LENGTH, 'Project name is too long.'),
  })
  .strict();

export function createProjectsRouter(db: Db, runtimeDir: string | null = null): Router {
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

  router.delete('/:id/worktrees', async (req, res) => {
    try {
      const result = await cleanupProjectWorktrees(db, runtimeDir, req.params.id);
      res.json(result);
    } catch (error) {
      sendApiError(res, error);
    }
  });

  return router;
}
