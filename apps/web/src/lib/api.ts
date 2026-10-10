import { bootstrapResponseSchema, healthResponseSchema } from '@hub/contracts';
import { z } from 'zod';
import { apiFetch } from './transport';
import { requestSignal } from './request-signal';
import { sessionResponseSchema, taskResponseSchema } from '@hub/contracts';
import {
  cachedSession,
  rememberSession,
  clearOffline,
  lockOffline,
  pendingCount,
  cacheResponse,
  cachedResponse,
  cacheTask,
  hasTaskQueue,
  enqueueTask,
  syncTasks,
  ownerContext,
  networkAvailability,
} from './offline';

export async function getJson<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  return requestJson(path, schema, signal ? { signal } : {});
}

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function liveRequestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const deadline = requestSignal(options.signal);
  const response = await apiFetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: deadline.signal,
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  }).finally(deadline.dispose);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const result = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(payload);
    const code = result.success ? result.data.error.code : 'REQUEST_FAILED';
    const messages: Record<string, string> = {
      PROVENANCE_UNAVAILABLE:
        'Source label history is incomplete. This context cannot be routed.',
      CANVAS_NOT_CONFIGURED: 'Configure the Canvas feed on the server first.',
      CANVAS_API_NOT_CONFIGURED:
        'Configure the Canvas API token on the server first.',
      SOURCE_UNAVAILABLE:
        'Canvas entry is missing or cancelled. Reload Canvas before planning.',
      SOURCE_IMMUTABLE: 'Planner source links cannot be replaced.',
      CANVAS_SYNC_ACTIVE:
        'Wait for the active refresh or pause it before importing.',
      CANVAS_ITEMS_LIMIT:
        'Too many retained Canvas entries. Export your data; paging is not available yet.',
      INVALID_FEED:
        'This is not a supported complete calendar feed. Previous records are unchanged.',
      UNSUPPORTED_FEED:
        'This feed uses unsupported recurrence, duration or floating/ambiguous times. Previous records are unchanged.',
      DUPLICATE_UID:
        'This feed contains duplicate event IDs. Previous records are unchanged.',
      FEED_TOO_LARGE: 'Calendar feed exceeds 1 MiB or 2,000 entries.',
      PASSWORD_MISMATCH: 'Current password is incorrect.',
      EXPORT_TOO_LARGE: 'Planner export exceeds the supported download size.',
      CURRENT_SESSION: 'Use Sign out for this session.',
      CALENDAR_EDITOR_REQUIRED:
        'Edit this event in Calendar to preserve its schedule and class links.',
      REMINDER_STATE:
        'The reminder status changed. Reload the list before trying again.',
      UNAUTHENTICATED: 'Your session ended. Sign out and sign in again.',
      INVALID_CREDENTIALS: 'Email or password is incorrect.',
      OWNER_EXISTS: 'This workspace already has an owner. Refresh to sign in.',
      SETUP_DISABLED: 'Enter the setup token configured on the server.',
      INVALID_INPUT: 'Check the entered values and try again.',
      VERSION_CONFLICT:
        'This item changed elsewhere. Your edits are still in the form. Reload the list before trying again.',
      OPERATION_CONFLICT:
        'This operation already has a different saved result. Reload before trying again.',
    };
    throw new RequestError(
      response.status,
      code,
      messages[code] ?? 'The server could not complete this request.',
    );
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success)
    throw new Error('The server returned an incompatible response.');
  if (typeof window !== 'undefined') networkAvailability(true);
  return parsed.data;
}

const cachedPath = (path: string) =>
  /^\/api\/v1\/connections\/canvas\/planner-work\?.+$/.test(path) ||
  /^\/api\/v1\/connections\/canvas\/lms\/records\?.+$/.test(path) ||
  /^\/api\/v1\/connections\/canvas\/(calendar|items)\?.+$/.test(path) ||
  /^\/api\/v1\/(tasks|events|calendar|courses|topics|reminders|notifications)(\/occurrences\?.*)?$/.test(
    path,
  );
export const synchronize = () =>
  syncTasks((path, options) => liveRequestJson(path, z.unknown(), options));
export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const mutation =
    /^\/api\/v1\/tasks(?:\/[a-f\d-]{36})?$/.test(path) &&
    ['POST', 'PUT', 'DELETE'].includes(method);
  const body =
    options.body && typeof options.body === 'object'
      ? (options.body as Record<string, unknown>)
      : {};
  const prepared =
    mutation && method === 'POST'
      ? { ...body, clientId: body.clientId ?? body.operationId }
      : body;
  const sourceCreation =
    mutation && method === 'POST' && !!body.canvasSourceRef;
  if (path === '/api/v1/auth/logout' && (await pendingCount().catch(() => 0)))
    throw new Error('Sync or discard pending tasks before signing out.');
  if (mutation && (await hasTaskQueue().catch(() => false))) {
    if (sourceCreation)
      throw new Error('Sync queued tasks before creating from Canvas.');
    const response = await enqueueTask(path, method, prepared);
    void synchronize().catch(() => undefined);
    return schema.parse(response);
  }
  try {
    const context = ownerContext();
    const response = await liveRequestJson(path, schema, {
      ...options,
      ...(mutation ? { body: prepared } : {}),
    });
    if (context !== ownerContext())
      throw new Error('Session changed. Reload to continue.');
    if (/^\/api\/v1\/auth\/(session|login|setup|password)$/.test(path))
      await rememberSession(sessionResponseSchema.parse(response)).catch(
        () => undefined,
      );
    if (path === '/api/v1/auth/logout')
      await clearOffline().catch(() => undefined);
    if (method === 'GET' && cachedPath(path)) {
      await cacheResponse(path, response).catch(() => undefined);
      if (
        path === '/api/v1/tasks' &&
        (await hasTaskQueue().catch(() => false))
      ) {
        void synchronize().catch(() => undefined);
        return schema.parse(await cachedResponse(path));
      }
    }
    if (mutation)
      await cacheTask(taskResponseSchema.parse(response).task).catch(
        () => undefined,
      );
    return response;
  } catch (error) {
    if (error instanceof RequestError) {
      if (
        error.status === 401 &&
        !/^\/api\/v1\/auth\/(login|setup|session)$/.test(path)
      ) {
        await lockOffline().catch(() => undefined);
        window.dispatchEvent(new Event('hub-auth-required'));
      }
      throw error;
    }
    if (
      options.signal?.aborted ||
      !(error instanceof TypeError || error instanceof DOMException)
    )
      throw error;
    networkAvailability(false);
    if (path === '/api/v1/auth/session') {
      const session = await cachedSession().catch(() => null);
      if (session) return schema.parse(session);
    }
    if (method === 'GET' && cachedPath(path)) {
      const data = await cachedResponse(path).catch(() => undefined);
      if (data !== undefined) return schema.parse(data);
    }
    if (mutation) {
      if (sourceCreation)
        throw new Error('Connect to create a task from Canvas.', {
          cause: error,
        });
      const response = await enqueueTask(path, method, prepared);
      void synchronize().catch(() => undefined);
      return schema.parse(response);
    }
    if (
      method !== 'GET' &&
      /^\/api\/v1\/(calendar|events|courses|topics|reminders|notifications)/.test(
        path,
      )
    )
      throw new Error('Connect to edit calendar, classes or reminders.', {
        cause: error,
      });
    throw error;
  }
}

export async function loadWorkspace() {
  const [health, bootstrap] = await Promise.all([
    getJson('/api/health', healthResponseSchema),
    getJson('/api/v1/bootstrap', bootstrapResponseSchema),
  ]);
  return { health, bootstrap };
}
