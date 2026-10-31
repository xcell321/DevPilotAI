import fs from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { TOKEN_META_NAME } from '../../shared/protocol.cjs';
import { createHealthHandler } from './api/health';
import { createOrchestrationRouter } from './api/orchestration';
import { createOverviewRouter } from './api/overview';
import { createProjectsRouter } from './api/projects';
import { createSessionsRouter } from './api/sessions';
import { createSettingsRouter } from './api/settings';
import { createSystemRouter } from './api/system';
import { createTerminalsRouter } from './api/terminals';
import { createToolsRouter } from './api/tools';
import type { AppConfig } from './config';
import type { Db } from './db/types';
import { requireToken } from './security/auth';
import { apiOriginGuard } from './security/origin';
import { createPtyLauncher } from './services/processLauncher';
import { OrchestrationService } from './services/orchestration';
import { ProcessManager } from './services/processManager';
import { SessionService } from './services/sessions';
import { WorkflowService } from './services/workflow';
import type { TerminalSupport } from './terminalSupport';

export interface CreateAppOptions {
  config: AppConfig;
  db: Db;
  token: string;
  terminalSupport: TerminalSupport;
  processManager?: ProcessManager;
  sessionService?: SessionService;
  orchestrationService?: OrchestrationService;
}

export function createApp({
  config,
  db,
  token,
  terminalSupport,
  processManager,
  sessionService: providedSessionService,
  orchestrationService: providedOrchestrationService,
}: CreateAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(apiOriginGuard);
  app.use(express.json({ limit: '64kb' }));

  const manager =
    processManager ??
    new ProcessManager({
      db,
      launcher: createPtyLauncher(),
      maxLive: config.maxTerminals,
    });
  const sessionService =
    providedSessionService ??
    new SessionService(db, manager, config.maxTerminalsPerSession, config.runtimeDir);
  const orchestrationService =
    providedOrchestrationService ??
    new OrchestrationService({
      db,
      sessions: sessionService,
      maxConcurrentAgents: config.maxConcurrentAgents,
      runtimeDir: config.runtimeDir,
    });
  const workflowService = new WorkflowService(db, sessionService, orchestrationService);

  app.get('/api/health', createHealthHandler(config, db, terminalSupport));
  app.use(
    '/api/overview',
    requireToken(token),
    createOverviewRouter(db, sessionService.maxTerminalsPerSession),
  );
  app.use('/api/sessions', requireToken(token), createSessionsRouter(sessionService));
  app.use(
    '/api/orchestration',
    requireToken(token),
    createOrchestrationRouter(orchestrationService, sessionService, workflowService),
  );
  app.use('/api/terminals', requireToken(token), createTerminalsRouter(sessionService));
  app.use('/api/tools', requireToken(token), createToolsRouter(db));
  app.use('/api/projects', requireToken(token), createProjectsRouter(db, config.runtimeDir));
  app.use('/api/settings', requireToken(token), createSettingsRouter(db));
  app.use('/api/system', requireToken(token), createSystemRouter());

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: { code: 'not_found', message: 'API route not found.' },
    });
  });

  const indexPath = path.join(config.webDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    app.use(express.static(config.webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || path.extname(req.path)) {
        next();
        return;
      }
      const tokenMetaPattern = new RegExp(
        `<meta\\s+name=["']${TOKEN_META_NAME}["'][^>]*>\\s*`,
        'gi',
      );
      const html = fs
        .readFileSync(indexPath, 'utf8')
        .replace(tokenMetaPattern, '')
        .replace(
          '</head>',
          `  <meta name="${TOKEN_META_NAME}" content="${token}" />\n  </head>`,
        );
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(html);
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const message = error instanceof Error ? error.message : 'Unexpected request failure.';
    const status =
      typeof (error as { status?: unknown } | null)?.status === 'number'
        ? (error as { status: number }).status
        : 500;

    if (status >= 400 && status < 500) {
      console.error(`Request rejected: ${message}`);
      res.status(status).json({
        error: {
          code: status === 413 ? 'payload_too_large' : 'invalid_request',
          message:
            status === 413 ? 'The request body is too large.' : 'The request body is invalid.',
        },
      });
      return;
    }

    console.error(`Request failed: ${message}`);
    res.status(500).json({
      error: { code: 'internal_error', message: 'Unexpected request failure.' },
    });
  };
  app.use(errorHandler);

  return app;
}
