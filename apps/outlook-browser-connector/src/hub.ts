import type { OutlookBrowserConnectorConfig } from './config.js';
import type { Folder, Message } from './extract.js';

export type CollectorState = {
  sourceVersion: number;
  folders: {
    id: string;
    providerId: string;
    canonicalUrl: string;
    version: number;
  }[];
};

export type Hub = {
  state: () => Promise<CollectorState>;
  begin: (attemptId: string, expectedSourceVersion: number) => Promise<void>;
  discovery: (
    attemptId: string,
    status: 'complete' | 'partial',
    capturedAt: string,
    folders: Folder[],
  ) => Promise<void>;
  folder: (
    attemptId: string,
    folderId: string,
    status: 'complete' | 'partial' | 'inaccessible',
    capturedAt: string,
    messages: Message[],
  ) => Promise<void>;
  finish: (
    attemptId: string,
    outcome: 'complete' | 'partial' | 'failed',
    errorCode?:
      | 'sign-in-required'
      | 'mfa-required'
      | 'browser-unavailable'
      | 'outlook-unavailable'
      | 'foreign-origin'
      | 'traversal-failed'
      | 'traversal-limit',
  ) => Promise<void>;
};

export class HubError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super('Hub refused Outlook browser collector request.');
  }
}

export function hubClient(config: OutlookBrowserConnectorConfig): Hub {
  const headers = {
    Authorization: `Bearer ${config.hubToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const url = (path: string) =>
    new URL(
      `/api/v1/outlook/browser/collector/${path}`,
      config.hubUrl,
    ).toString();
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(url(path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(60000),
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
    discovery: (attemptId, status, capturedAt, folders) =>
      post('discovery', { attemptId, status, capturedAt, folders }),
    folder: (attemptId, folderId, status, capturedAt, messages) =>
      post('folder', { attemptId, folderId, status, capturedAt, messages }),
    finish: (attemptId, outcome, errorCode) =>
      post('attempt/finish', {
        attemptId,
        outcome,
        errorCode: errorCode ?? null,
      }),
  };
}
