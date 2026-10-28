import { Router } from 'express';
import type { Db } from '../db/types';
import { listToolProfiles } from '../services/toolRegistry';

interface CountsRow {
  projects: number;
  sessions: number;
  toolProfiles: number;
  enabledToolProfiles: number;
  runningTerminals: number;
}

export function createOverviewRouter(db: Db): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM projects) AS projects,
           (SELECT COUNT(*) FROM sessions) AS sessions,
           (SELECT COUNT(*) FROM tool_profiles) AS toolProfiles,
           (SELECT COUNT(*) FROM tool_profiles WHERE enabled = 1) AS enabledToolProfiles,
           (SELECT COUNT(*) FROM session_terminals WHERE process_status = 'running') AS runningTerminals`,
      )
      .get() as CountsRow;

    res.json({
      counts: {
        projects: Number(counts.projects),
        sessions: Number(counts.sessions),
        toolProfiles: Number(counts.toolProfiles),
        enabledToolProfiles: Number(counts.enabledToolProfiles),
        runningTerminals: Number(counts.runningTerminals),
      },
      tools: listToolProfiles(db),
    });
  });

  return router;
}
