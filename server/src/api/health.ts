import type { RequestHandler } from 'express';
import type { AppConfig } from '../config';
import type { Db } from '../db/types';
import type { TerminalSupport } from '../terminalSupport';

export function createHealthHandler(
  config: AppConfig,
  db: Db,
  terminalSupport: TerminalSupport,
): RequestHandler {
  return (req, res) => {
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    res.json({
      status: 'ok',
      app: {
        name: 'DevPilot AI',
        version: config.version,
      },
      backend: {
        status: 'ok',
        host: config.host,
        port: req.socket.localPort ?? config.port,
        uptimeSeconds: Math.round(process.uptime()),
      },
      terminalSupport,
      database: {
        status: 'ok',
        schemaVersion,
      },
    });
  };
}
