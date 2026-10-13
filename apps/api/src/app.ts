import Fastify from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { bootstrapResponseSchema, healthResponseSchema } from '@hub/contracts';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { readConfig } from './config.js';
import type { Config } from './config.js';
import type { Database } from './db/database.js';
import { registerAuth } from './auth/routes.js';
import { registerAccount } from './auth/account.js';
import { registerExport } from './features/export.js';
import { registerCanvas, startCanvasWorker } from './connections/canvas.js';
import { FeedError } from './connections/canvas-feed.js';
import type { FeedFetcher } from './connections/canvas-feed.js';
import {
  registerCanvasLms,
  startCanvasLmsWorker,
} from './connections/canvas-lms.js';
import type { CanvasApiFetcher } from './connections/canvas-api.js';
import { registerCanvasReconciliation } from './connections/canvas-reconciliation.js';
import { registerCanvasPlannerWork } from './connections/canvas-planner-work.js';
import { registerAIRouting } from './features/ai-routing.js';
import { registerAIPreflight } from './features/ai-preflight.js';
import { registerAIBudget } from './features/ai-budget.js';
import { registerAIProviderPolicy } from './features/ai-provider-policy.js';
import { registerAIRequests } from './features/ai-requests.js';
import { registerStudy } from './features/study.js';
import { registerDeletedPlanner } from './features/deleted-planner.js';
import { registerReminderInbox } from './features/reminder-inbox.js';
import { registerAcademicWork } from './features/academic-work.js';
import { registerAcademicManagement } from './features/academic-management.js';
import { registerAcademicPlanning } from './features/academic-planning.js';
import { registerToday } from './features/today.js';
import { registerTaskManagement } from './features/task-management.js';
import { registerAIActions } from './features/ai-actions.js';
import { registerAssistant } from './features/assistant.js';
import {
  connectorPathPrefix,
  registerEmailIngestion,
} from './features/email-ingestion.js';
import type { OpenRouterFetch } from './ai/openrouter-live.js';
import { registerEmailDrafts } from './features/email-drafts.js';
import { registerMemory } from './features/memory.js';
import { registerResponsibilities } from './features/responsibilities.js';
import { registerResponsibilityInbox } from './features/responsibility-inbox.js';
import { registerPlanner } from './planner/routes.js';
import { ApiError } from './errors.js';
import { registerAcademics } from './features/academics.js';
import { registerCalendar } from './features/calendar.js';
import { registerCalendarManagement } from './features/calendar-management.js';
import {
  registerReminders,
  startReminderWorker,
} from './features/reminders.js';

export async function buildApp(
  options: FastifyServerOptions = {},
  runtime: {
    config?: Config;
    database?: Database;
    runWorker?: boolean;
    canvasFetcher?: FeedFetcher;
    canvasApiFetcher?: CanvasApiFetcher;
    /** Tests inject this; the default is the global fetch. */
    openRouterFetch?: OpenRouterFetch;
  } = {},
) {
  const config = runtime.config ?? readConfig({});
  const database = runtime.database ?? (await openDatabase(config));
  try {
    await migrate(database);
  } catch (error) {
    await database.close();
    throw error;
  }
  const app = Fastify({ bodyLimit: 64 * 1024, ...options });
  let worker: ReturnType<typeof startReminderWorker> | undefined;
  let canvasWorker: ReturnType<typeof startCanvasWorker> | undefined;
  let canvasLmsWorker: ReturnType<typeof startCanvasLmsWorker> | undefined;
  app.addHook('onClose', async () => {
    await worker?.stop();
    await canvasWorker?.stop();
    await canvasLmsWorker?.stop();
    await database.close();
  });
  await app.register(cookie);
  // Isolated browser suites exercise many page lifetimes in seconds. Keep the
  // deployed limit unchanged; enrollment/login retain their own tighter limit.
  await app.register(rateLimit, {
    max: config.NODE_ENV === 'test' ? 3000 : 300,
    timeWindow: '1 minute',
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      // The local mail connector is not a browser: it authenticates with a
      // bearer token instead of a session cookie, so CSRF origin checks do
      // not apply to its routes.
      const connector =
        request.url.startsWith(connectorPathPrefix) &&
        request.headers.authorization?.startsWith('Bearer hubc_');
      if (
        !connector &&
        (!request.headers.origin ||
          !config.WEB_ORIGINS.includes(request.headers.origin))
      )
        throw new ApiError(
          403,
          'ORIGIN_REJECTED',
          'This request origin is not allowed.',
        );
      if (!request.headers['content-type']?.startsWith('application/json'))
        throw new ApiError(415, 'JSON_REQUIRED', 'Use a JSON request body.');
    }
  });
  const auth = registerAuth(app, database, config);
  registerAccount(app, database, auth);
  registerExport(app, database, auth);
  registerCanvas(app, database, auth, config);
  registerCanvasLms(app, database, auth, config);
  registerCanvasReconciliation(app, database, auth);
  registerCanvasPlannerWork(app, database, auth);
  registerAIRouting(app, database, auth);
  registerAIPreflight(app, database, auth, config);
  registerAIBudget(app, database, auth);
  registerAIProviderPolicy(app, database, auth, config);
  registerAIRequests(app, database, auth, config);
  registerAIActions(app, database, auth);
  registerAssistant(app, database, auth, config, runtime.openRouterFetch);
  registerEmailDrafts(app, database, auth);
  registerEmailIngestion(app, database, auth);
  registerMemory(app, database, auth);
  registerResponsibilities(app, database, auth);
  registerResponsibilityInbox(app, database, auth);
  registerStudy(app, database, auth);
  registerDeletedPlanner(app, database, auth);
  registerPlanner(app, database, auth);
  registerAcademics(app, database, auth);
  registerAcademicWork(app, database, auth);
  registerAcademicManagement(app, database, auth);
  registerAcademicPlanning(app, database, auth);
  registerToday(app, database, auth);
  registerTaskManagement(app, database, auth);
  registerCalendar(app, database, auth);
  registerCalendarManagement(app, database, auth);
  registerReminders(app, database, auth);
  registerReminderInbox(app, database, auth);
  if (runtime.runWorker)
    app.addHook('onReady', async () => {
      worker = startReminderWorker(database);
      canvasWorker = startCanvasWorker(database, config, runtime.canvasFetcher);
      canvasLmsWorker = startCanvasLmsWorker(
        database,
        config,
        runtime.canvasApiFetcher,
      );
    });

  app.get('/api/health', async () =>
    healthResponseSchema.parse({
      status: 'ok',
      service: 'productivity-hub-api',
      contractVersion: 1,
    }),
  );

  app.get('/api/v1/bootstrap', async (_, reply) => {
    reply.header('Cache-Control', 'no-store');
    return bootstrapResponseSchema.parse({
      mode: 'development',
      connections: [
        {
          id: 'canvas',
          name: 'Canvas',
          description: 'Classes, assignments, and academic deadlines.',
          status: 'not_configured',
        },
        {
          id: 'outlook',
          name: 'School Outlook',
          description: 'School mail and actionable messages.',
          status: 'not_configured',
        },
        {
          id: 'proton-mail',
          name: 'Proton Mail',
          description: 'Personal mail, including your connected Gmail.',
          status: 'not_configured',
        },
        {
          id: 'proton-calendar',
          name: 'Proton Calendar',
          description: 'Your existing schedule and commitments.',
          status: 'not_configured',
        },
      ],
    });
  });

  app.setNotFoundHandler((_, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.' },
    }),
  );

  app.get('/api/ready', async (_, reply) => {
    try {
      await database.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof FeedError)
      return reply.code(400).send({
        error: {
          code: error.code,
          message: 'Calendar feed could not be imported.',
        },
      });
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: 'INVALID_INPUT',
          message: 'Check the entered values and try again.',
        },
      });
    const statusCode =
      error instanceof Error && 'statusCode' in error
        ? error.statusCode
        : undefined;
    const status =
      typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
        ? statusCode
        : 500;
    if (status === 500)
      request.log.error({ requestId: request.id }, 'Request failed');
    return reply.code(status).send({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
        message:
          status === 500
            ? 'The request could not be completed.'
            : 'The request is invalid.',
      },
    });
  });

  return app;
}
