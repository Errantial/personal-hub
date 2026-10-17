import type { CanvasBrowserConnectorConfig } from './config.js';

export type CollectorState = {
  sourceVersion: number;
  courses: {
    id: string;
    providerId: string;
    canonicalUrl: string;
    version: number;
  }[];
};

export type Course = {
  providerId: string;
  name: string;
  canonicalUrl: string;
};

export type Item = {
  resourceKind: 'assignment' | 'quiz';
  providerId: string;
  canonicalUrl: string;
  title: string;
  dueAt: string | null;
};

export type Hub = {
  state: () => Promise<CollectorState>;
  begin: (attemptId: string, expectedSourceVersion: number) => Promise<void>;
  discovery: (
    attemptId: string,
    status: 'complete' | 'partial',
    capturedAt: string,
    courses: Course[],
  ) => Promise<void>;
  course: (
    attemptId: string,
    courseId: string,
    status: 'complete' | 'partial' | 'inaccessible',
    capturedAt: string,
    items: Item[],
  ) => Promise<void>;
  finish: (
    attemptId: string,
    outcome: 'complete' | 'partial' | 'failed',
    errorCode?:
      | 'sign-in-required'
      | 'browser-unavailable'
      | 'canvas-unavailable'
      | 'traversal-failed'
      | 'traversal-limit',
  ) => Promise<void>;
};

export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super('Hub refused Canvas browser collector request.');
  }
}

export function hubClient(config: CanvasBrowserConnectorConfig): Hub {
  const headers = {
    Authorization: `Bearer ${config.hubToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const url = (path: string) =>
    new URL(
      `/api/v1/canvas/browser/collector/${path}`,
      config.hubUrl,
    ).toString();
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(url(path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const code = (
        (await response.json().catch(() => null)) as {
          error?: { code?: string };
        } | null
      )?.error?.code;
      throw new HubError(response.status, code ?? null);
    }
    return response;
  };
  const post = async (path: string, body: unknown) => {
    await request(path, { method: 'POST', body: JSON.stringify(body) });
  };
  return {
    state: async () =>
      (await (await request('state')).json()) as CollectorState,
    begin: (attemptId, expectedSourceVersion) =>
      post('attempt', { attemptId, expectedSourceVersion }),
    discovery: (attemptId, status, capturedAt, courses) =>
      post('discovery', { attemptId, status, capturedAt, courses }),
    course: (attemptId, courseId, status, capturedAt, items) =>
      post('course', { attemptId, courseId, status, capturedAt, items }),
    finish: (attemptId, outcome, errorCode) =>
      post('attempt/finish', {
        attemptId,
        outcome,
        errorCode: errorCode ?? null,
      }),
  };
}
