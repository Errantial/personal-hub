import { bootstrapResponseSchema, healthResponseSchema } from '@hub/contracts';
import { z } from 'zod';

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

export async function requestJson<T>(
  path: string,
  schema: z.ZodType<T>,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000),
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const result = z
      .object({ error: z.object({ code: z.string() }) })
      .safeParse(payload);
    const code = result.success ? result.data.error.code : 'REQUEST_FAILED';
    const messages: Record<string, string> = {
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
  return parsed.data;
}

export async function loadWorkspace() {
  const signal = AbortSignal.timeout(8000);
  const [health, bootstrap] = await Promise.all([
    getJson('/api/health', healthResponseSchema, signal),
    getJson('/api/v1/bootstrap', bootstrapResponseSchema, signal),
  ]);
  return { health, bootstrap };
}
